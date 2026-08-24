import type { HttpResponse } from "../exceptions.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type TransportBody = string | URLSearchParams | Uint8Array<ArrayBuffer>;

export interface ReplayableBody {
  readonly contentType?: string;
  create(): TransportBody;
}

export interface TransportRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: ReplayableBody;
  readonly signal?: AbortSignal;
}

export interface TransportResponse extends HttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  text(): string;
  json(): unknown;
}

export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
  isRetryableError?(error: unknown): boolean;
}

export interface WebSocketLike {
  close(): void;
  addEventListener(
    type: "close" | "error" | "message",
    listener: (event: unknown) => void,
  ): void;
  removeEventListener(
    type: "close" | "error" | "message",
    listener: (event: unknown) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Create a WebSocket using the standards-compatible implementation in Node 22. */
export const nodeWebSocketFactory: WebSocketFactory = (url) =>
  new WebSocket(url);

export type ResponseParser<T> = (response: TransportResponse) => T;

export function jsonParser<T>(
  validate: (value: unknown) => T,
): ResponseParser<T> {
  return (response) => validate(response.json());
}

export const unknownJsonParser: ResponseParser<unknown> = (response) =>
  response.json();
export const textParser: ResponseParser<string> = (response) => response.text();

export function replayableText(
  value: string,
  contentType?: string,
): ReplayableBody {
  return contentType === undefined
    ? { create: () => value }
    : { contentType, create: () => value };
}

export function replayableBytes(
  value: Uint8Array,
  contentType?: string,
): ReplayableBody {
  const snapshot = new Uint8Array(value).buffer;
  const create = (): Uint8Array<ArrayBuffer> =>
    new Uint8Array(snapshot.slice(0));
  return contentType === undefined ? { create } : { contentType, create };
}

export function replayableJson(value: JsonValue): ReplayableBody {
  const serialized = JSON.stringify(value);
  return replayableText(serialized, "application/json");
}

export function replayableForm(
  entries: Iterable<readonly [string, string]>,
): ReplayableBody {
  const snapshot = Array.from(entries, ([key, value]) => [key, value]);
  return {
    contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    create: () => new URLSearchParams(snapshot),
  };
}

export interface MultipartFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly fieldName?: string;
  readonly name: string;
}

function multipartHeader(value: string): string {
  return value.replaceAll("\r", "").replaceAll("\n", "").replaceAll('"', "%22");
}

/** Snapshot a multipart form as bytes so retries send an identical payload. */
export function replayableMultipart(
  entries: Iterable<readonly [string, string]>,
  file: MultipartFile,
  boundary = `----traw-${crypto.randomUUID()}`,
): ReplayableBody {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const append = (value: string): void => {
    parts.push(encoder.encode(value));
  };
  for (const [name, value] of entries) {
    append(
      `--${boundary}\r\nContent-Disposition: form-data; name="${multipartHeader(name)}"\r\n\r\n${value}\r\n`,
    );
  }
  append(
    `--${boundary}\r\nContent-Disposition: form-data; name="${multipartHeader(file.fieldName ?? "file")}"; filename="${multipartHeader(file.name)}"\r\nContent-Type: ${multipartHeader(file.contentType)}\r\n\r\n`,
  );
  parts.push(new Uint8Array(file.bytes));
  append(`\r\n--${boundary}--\r\n`);

  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const snapshot = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    snapshot.set(part, offset);
    offset += part.byteLength;
  }
  return replayableBytes(snapshot, `multipart/form-data; boundary=${boundary}`);
}
