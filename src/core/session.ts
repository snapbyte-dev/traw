import {
  BadJSON,
  BadRequest,
  Conflict,
  Forbidden,
  InvalidToken,
  NotFound,
  Redirect,
  RequestException,
  ResponseException,
  ServerError,
  SpecialError,
  TooLarge,
  TooManyRequests,
  URITooLong,
  UnavailableForLegalReasons,
} from "../exceptions.js";
import { RateLimiter } from "./rate-limiter.js";
import { RetryStrategy, type RetryOptions } from "./retry.js";
import {
  replayableForm,
  replayableJson,
  type JsonValue,
  type ReplayableBody,
  type ResponseParser,
  type Transport,
  type TransportResponse,
} from "./transport.js";

type Parameter = boolean | number | string;
type ParameterValue = Parameter | readonly Parameter[];

export interface HeaderProvider {
  headers(
    signal?: AbortSignal,
  ):
    | Promise<Readonly<Record<string, string>>>
    | Readonly<Record<string, string>>;
  invalidate(): Promise<void> | void;
  canRefresh?(): boolean;
}

export interface SessionOptions extends RetryOptions {
  readonly baseUrl: string;
  readonly transport: Transport;
  readonly headerProvider?: HeaderProvider;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rateLimiter?: RateLimiter;
  readonly windowSizeMs?: number;
}

interface CommonRequestOptions {
  readonly auth?: boolean;
  readonly method: string;
  readonly path: string;
  readonly rawJson?: boolean;
  readonly responseType?: "json" | "text";
  readonly params?: Readonly<Record<string, ParameterValue>>;
  readonly data?: Readonly<Record<string, ParameterValue>> | ReplayableBody;
  readonly json?: JsonValue;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ParsedRequestOptions<T> extends CommonRequestOptions {
  readonly parse: ResponseParser<T>;
}

export interface JsonRequestOptions extends CommonRequestOptions {
  readonly parse?: undefined;
}

type DefaultResponse = JsonValue | string | null;
type ExceptionConstructor = new (response: TransportResponse) => Error;

const STATUS_EXCEPTIONS: Readonly<Record<number, ExceptionConstructor>> = {
  301: Redirect,
  302: Redirect,
  400: BadRequest,
  401: InvalidToken,
  403: Forbidden,
  404: NotFound,
  409: Conflict,
  413: TooLarge,
  414: URITooLong,
  415: SpecialError,
  429: TooManyRequests,
  451: UnavailableForLegalReasons,
  500: ServerError,
  501: ServerError,
  502: ServerError,
  503: ServerError,
  504: ServerError,
  505: ServerError,
  506: ServerError,
  507: ServerError,
  508: ServerError,
  509: ServerError,
  510: ServerError,
  511: ServerError,
  520: ServerError,
  522: ServerError,
};

const RETRY_STATUSES = new Set([408, 500, 502, 503, 504, 520, 522]);

function appendParameters(
  target: URLSearchParams,
  parameters: Readonly<Record<string, ParameterValue>>,
): void {
  for (const [key, value] of Object.entries(parameters)) {
    if (Array.isArray(value)) {
      for (const item of value) target.append(key, String(item));
    } else {
      target.append(key, String(value));
    }
  }
}

function isReplayableBody(
  data: Readonly<Record<string, ParameterValue>> | ReplayableBody,
): data is ReplayableBody {
  return "create" in data && typeof data.create === "function";
}

function requestBody(
  options: CommonRequestOptions,
): ReplayableBody | undefined {
  if (options.data !== undefined && options.json !== undefined) {
    throw new TypeError("data and json cannot both be provided");
  }
  if (options.json !== undefined) {
    if (
      Array.isArray(options.json) ||
      options.json === null ||
      typeof options.json !== "object"
    ) {
      return replayableJson(options.json);
    }
    return replayableJson({ ...options.json, api_type: "json" });
  }
  if (options.data === undefined) return undefined;
  if (isReplayableBody(options.data)) return options.data;

  const form = new URLSearchParams();
  appendParameters(form, options.data);
  form.set("api_type", "json");
  return replayableForm(form);
}

function parseDefault(response: TransportResponse): DefaultResponse {
  if (response.status === 204) return null;
  if (response.headers["content-length"] === "0" || response.body.length === 0)
    return "";
  try {
    return response.json() as JsonValue;
  } catch {
    throw new BadJSON(response);
  }
}

function responseException(response: TransportResponse): Error {
  if (response.status === 415) {
    try {
      const payload = response.json();
      if (typeof payload === "object" && payload !== null) {
        const data = payload as Record<string, unknown>;
        return new SpecialError(response, {
          ...(typeof data["message"] === "string"
            ? { message: data["message"] }
            : {}),
          ...(typeof data["reason"] === "string"
            ? { reason: data["reason"] }
            : {}),
          ...(Array.isArray(data["special_errors"])
            ? { specialErrors: data["special_errors"] as unknown[] }
            : {}),
        });
      }
    } catch {
      return new SpecialError({ ...response, json: () => undefined });
    }
  }
  if (response.status >= 500 && response.status <= 599)
    return new ServerError(response);
  const Exception = STATUS_EXCEPTIONS[response.status] ?? ResponseException;
  return new Exception(response);
}

export class Session {
  readonly rateLimiter: RateLimiter;
  readonly #baseUrl: URL;
  readonly #headerProvider: HeaderProvider | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #retry: RetryStrategy;
  readonly #transport: Transport;

  constructor(options: SessionOptions) {
    this.#baseUrl = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    this.#transport = options.transport;
    this.#headerProvider = options.headerProvider;
    this.#headers = options.headers ?? {};
    this.rateLimiter =
      options.rateLimiter ??
      new RateLimiter({
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.windowSizeMs === undefined
          ? {}
          : { windowSizeMs: options.windowSizeMs }),
      });
    this.#retry = new RetryStrategy(options);
  }

  request<T>(options: ParsedRequestOptions<T>): Promise<T>;
  request(options: JsonRequestOptions): Promise<DefaultResponse>;
  async request<T>(
    options: ParsedRequestOptions<T> | JsonRequestOptions,
  ): Promise<T | DefaultResponse> {
    const url = new URL(options.path, this.#baseUrl);
    appendParameters(url.searchParams, options.params ?? {});
    if (options.rawJson !== false) url.searchParams.set("raw_json", "1");
    const body = requestBody(options);

    for (let attempt = 1; attempt <= this.#retry.attempts; attempt += 1) {
      await this.#retry.waitBefore(attempt, options.signal);
      await this.rateLimiter.delay(options.signal);
      const injectedHeaders =
        options.auth === false
          ? {}
          : ((await this.#headerProvider?.headers(options.signal)) ?? {});
      let response: TransportResponse;

      try {
        response = await this.#transport.send({
          headers: { ...this.#headers, ...options.headers, ...injectedHeaders },
          method: options.method,
          url: url.toString(),
          ...(body === undefined ? {} : { body }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (
          attempt < this.#retry.attempts &&
          error instanceof RequestException &&
          this.#transport.isRetryableError?.(error) === true
        )
          continue;
        throw error;
      }

      this.rateLimiter.update(response.headers);
      const retryStatus =
        RETRY_STATUSES.has(response.status) ||
        (options.auth !== false &&
          response.status === 401 &&
          this.#headerProvider?.canRefresh?.() === true);
      if (options.auth !== false && response.status === 401)
        await this.#headerProvider?.invalidate();
      if (retryStatus && attempt < this.#retry.attempts) continue;

      if (response.status === 204) return null;
      if (response.status < 200 || response.status > 299) {
        throw responseException(response);
      }
      if ("parse" in options && options.parse !== undefined)
        return options.parse(response);
      if (options.responseType === "text") return response.text();
      return parseDefault(response);
    }
    throw new Error("retry loop exhausted");
  }
}
