import { RequestError } from "../exceptions.js";
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from "./transport.js";

export type FetchImplementation = typeof fetch;

export interface FetchTransportOptions {
  readonly timeoutMs?: number;
}

class BufferedResponse implements TransportResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(response: Response, bytes: Uint8Array<ArrayBuffer>) {
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = response.url;
    this.headers = Object.fromEntries(response.headers);
    this.#bytes = bytes;
    this.body = new TextDecoder().decode(this.#bytes);
  }

  json(): unknown {
    return JSON.parse(this.text()) as unknown;
  }

  text(): string {
    return this.body;
  }
}

export class FetchTransport implements Transport {
  readonly #fetch: FetchImplementation;
  readonly #timeoutMs: number | undefined;
  readonly #retryableErrors = new WeakSet<object>();

  constructor(
    fetchImplementation: FetchImplementation = fetch,
    options: FetchTransportOptions = {},
  ) {
    this.#fetch = fetchImplementation;
    this.#timeoutMs = options.timeoutMs;
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    const headers = new Headers(request.headers);
    if (
      request.body?.contentType !== undefined &&
      !headers.has("content-type")
    ) {
      headers.set("content-type", request.body.contentType);
    }

    const timeoutSignal =
      this.#timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(this.#timeoutMs);
    const signal =
      timeoutSignal === undefined
        ? request.signal
        : request.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([request.signal, timeoutSignal]);

    try {
      const init: RequestInit = {
        headers,
        method: request.method,
        redirect: "manual",
        ...(request.body === undefined ? {} : { body: request.body.create() }),
        ...(signal === undefined ? {} : { signal }),
      };
      const response = await this.#fetch(request.url, init);
      const buffer = await response.arrayBuffer();
      return new BufferedResponse(response, new Uint8Array(buffer));
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw request.signal.reason ?? error;
      }
      const requestError = new RequestError(
        timeoutSignal?.aborted === true
          ? (timeoutSignal.reason ?? error)
          : error,
        request,
      );
      this.#retryableErrors.add(requestError);
      throw requestError;
    }
  }

  isRetryableError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      this.#retryableErrors.has(error)
    );
  }
}
