import { readFile } from "node:fs/promises";

import type {
  Transport,
  TransportBody,
  TransportRequest,
  TransportResponse,
} from "../../src/core/transport.js";

export interface CassetteBody {
  readonly encoding: "base64" | "utf8";
  readonly value: string;
}

export interface CassetteRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: CassetteBody;
}

export interface CassetteResponse {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CassetteInteraction {
  readonly request: CassetteRequest;
  readonly response: CassetteResponse;
}

export interface Cassette {
  readonly version: 1;
  readonly policy: {
    readonly authorization: "ignore";
  };
  readonly interactions: readonly CassetteInteraction[];
}

class CassetteResponseBuffer implements TransportResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;

  constructor(response: CassetteResponse) {
    this.body = response.body;
    this.headers = { ...response.headers };
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = response.url;
  }

  json(): unknown {
    return JSON.parse(this.body) as unknown;
  }

  text(): string {
    return this.body;
  }
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const entries = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? compare(leftValue, rightValue)
        : compare(leftKey, rightKey),
  );
  url.search = "";
  for (const [key, entryValue] of entries) {
    url.searchParams.append(key, entryValue);
  }
  return url.toString();
}

function normalizeHeaders(request: TransportRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const normalizedName = name.toLowerCase();
    if (normalizedName !== "authorization") {
      headers[normalizedName] = value.trim();
    }
  }
  if (
    request.body?.contentType !== undefined &&
    headers["content-type"] === undefined
  ) {
    headers["content-type"] = request.body.contentType.trim();
  }
  return headers;
}

function encodeBody(body: TransportBody): CassetteBody {
  if (body instanceof Uint8Array) {
    return { encoding: "base64", value: Buffer.from(body).toString("base64") };
  }
  return { encoding: "utf8", value: body.toString() };
}

function actualRequest(request: TransportRequest): CassetteRequest {
  return {
    method: request.method,
    url: normalizeUrl(request.url),
    headers: normalizeHeaders(request),
    ...(request.body === undefined
      ? {}
      : { body: encodeBody(request.body.create()) }),
  };
}

function assertRequest(
  expected: CassetteRequest,
  actual: CassetteRequest,
): void {
  const expectedHeaders = Object.fromEntries(
    Object.entries(expected.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value.trim(),
    ]),
  );
  if (expectedHeaders["authorization"] !== undefined) {
    throw new Error(
      "Cassette request headers must not contain authorization; policy requires redaction",
    );
  }

  const relevantActualHeaders = Object.fromEntries(
    Object.keys(expectedHeaders).map((name) => [name, actual.headers?.[name]]),
  );
  const expectedComparable = {
    body: expected.body,
    headers: expectedHeaders,
    method: expected.method,
    url: normalizeUrl(expected.url),
  };
  const actualComparable = {
    body: actual.body,
    headers: relevantActualHeaders,
    method: actual.method,
    url: actual.url,
  };
  if (JSON.stringify(actualComparable) !== JSON.stringify(expectedComparable)) {
    throw new Error(
      `Cassette request mismatch\nExpected: ${JSON.stringify(expectedComparable)}\nActual: ${JSON.stringify(actualComparable)}`,
    );
  }
}

function parseCassette(value: unknown): Cassette {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Cassette must be a JSON object");
  }
  const candidate = value as Partial<Cassette>;
  if (
    candidate.version !== 1 ||
    candidate.policy?.authorization !== "ignore" ||
    !Array.isArray(candidate.interactions)
  ) {
    throw new TypeError(
      'Cassette requires version 1, policy.authorization "ignore", and interactions',
    );
  }
  return candidate as Cassette;
}

export class CassetteTransport implements Transport {
  readonly #cassette: Cassette;
  #cursor = 0;

  constructor(cassette: Cassette) {
    this.#cassette = cassette;
  }

  static async fromFile(path: string | URL): Promise<CassetteTransport> {
    const content = await readFile(path, "utf8");
    return new CassetteTransport(parseCassette(JSON.parse(content) as unknown));
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    if (request.signal?.aborted === true) {
      throw request.signal.reason;
    }
    const interaction = this.#cassette.interactions[this.#cursor];
    if (interaction === undefined) {
      throw new Error(
        `Unexpected cassette request: ${request.method} ${normalizeUrl(request.url)}`,
      );
    }
    assertRequest(interaction.request, actualRequest(request));
    this.#cursor += 1;
    return new CassetteResponseBuffer(interaction.response);
  }

  assertConsumed(): void {
    const remaining = this.#cassette.interactions.length - this.#cursor;
    if (remaining !== 0) {
      const next = this.#cassette.interactions[this.#cursor]!.request;
      throw new Error(
        `Cassette has ${remaining} unused interaction(s); next is ${next.method} ${normalizeUrl(next.url)}`,
      );
    }
  }
}
