export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers?: HttpHeaders | Readonly<Record<string, string | undefined>>;
  readonly url?: string;
  readonly body?: unknown;
  text?(): string;
  json?(): unknown;
}

export interface RequestMetadata {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

function header(response: HttpResponse, name: string): string | null {
  const { headers } = response;
  if (headers === undefined) return null;
  const candidate = headers as HttpHeaders;
  if (typeof candidate.get === "function") {
    const value: unknown = candidate.get(name);
    return typeof value === "string" ? value : null;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target)
      return typeof value === "string" ? value : null;
  }
  return null;
}

class NamedError extends Error {
  constructor(message = "", options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class TrawError extends NamedError {}

export class ClientError extends TrawError {}

export class DuplicateReplaceError extends ClientError {
  constructor() {
    super(
      "A duplicate comment has been detected. Are you attempting to call 'replace_more_comments' more than once?",
    );
  }
}

export class InvalidFlairTemplateIdError extends ClientError {
  readonly templateId: string;

  constructor(templateId: string) {
    super(
      `The flair template ID '${templateId}' is invalid. If you are trying to create a flair, please use the 'add' method.`,
    );
    this.templateId = templateId;
  }
}

export class InvalidImplicitAuthError extends ClientError {
  constructor() {
    super("Implicit authorization can only be used with installed apps.");
  }
}

export class InvalidUrlError extends ClientError {
  readonly url: string;

  constructor(url: string, message = "Invalid URL: {}") {
    super(message.replaceAll("{}", url).replaceAll("{0}", url));
    this.url = url;
  }
}

export class MissingRequiredAttributeError extends ClientError {}

export class ReadOnlyError extends ClientError {}

export class MediaTooLargeError extends ClientError {
  readonly actual: number;
  readonly maximumSize: number;

  constructor(options: {
    readonly actual: number;
    readonly maximumSize: number;
  }) {
    const { actual, maximumSize } = options;
    super(
      `The media that you uploaded was too large (maximum size is ${maximumSize} bytes, uploaded ${actual} bytes)`,
    );
    this.actual = actual;
    this.maximumSize = maximumSize;
  }
}

export class WebSocketError extends ClientError {}

export class MediaPostFailedError extends WebSocketError {
  constructor() {
    super(
      "The attempted media upload action has failed. Possible causes include the corruption of media files. Check that the media file can be opened on your local machine.",
    );
  }
}

function quoted(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export class RedditErrorItem {
  readonly errorType: string;
  readonly message: string | null;
  readonly field: string | null;

  constructor(
    errorType: string,
    options: {
      readonly message?: string | null;
      readonly field?: string | null;
    } = {},
  ) {
    this.errorType = errorType;
    this.message = options.message ?? null;
    this.field = options.field ?? null;
  }

  get errorMessage(): string {
    let result = this.errorType;
    if (this.message) result += `: ${quoted(this.message)}`;
    if (this.field) result += ` on field ${quoted(this.field)}`;
    return result;
  }

  equals(other: unknown): other is RedditErrorItem {
    return (
      other instanceof RedditErrorItem &&
      this.errorType === other.errorType &&
      this.message === other.message &&
      this.field === other.field
    );
  }

  toString(): string {
    return this.errorMessage;
  }
}

export type RedditErrorTuple = readonly [
  errorType: string,
  message?: string | null,
  field?: string | null,
];
export type RedditError = RedditErrorItem | RedditErrorTuple;

export class RedditApiError extends TrawError {
  readonly items: readonly RedditErrorItem[];

  static parseExceptionList(errors: readonly RedditError[]): RedditErrorItem[] {
    return errors.map((error) => {
      if (error instanceof RedditErrorItem) return error;
      const [errorType, message, field] = error;
      return new RedditErrorItem(errorType, {
        message: message === "" || message === undefined ? null : message,
        field: field === "" || field === undefined ? null : field,
      });
    });
  }

  constructor(errors: RedditError | readonly RedditError[]) {
    let list: readonly RedditError[];
    if (errors instanceof RedditErrorItem) {
      list = [errors];
    } else if (typeof errors[0] === "string") {
      list = [errors as RedditErrorTuple];
    } else {
      list = errors as readonly RedditError[];
    }
    const items = RedditApiError.parseExceptionList(list);
    super(items.map(String).join(", "));
    this.items = items;
  }
}

export class RedditCoreError extends NamedError {}

export class InvalidInvocationError extends RedditCoreError {}

export class OAuthError extends RedditCoreError {
  readonly response: HttpResponse;
  readonly error: string;
  readonly description: string | null;

  constructor(
    response: HttpResponse,
    error: string,
    description: string | null = null,
  ) {
    super(
      `${error} error processing request${description ? ` (${description})` : ""}`,
    );
    this.response = response;
    this.error = error;
    this.description = description;
  }
}

export class RequestError extends RedditCoreError {
  readonly originalError: unknown;
  readonly request: Readonly<RequestMetadata>;

  constructor(originalError: unknown, request: Readonly<RequestMetadata> = {}) {
    const detail =
      originalError instanceof Error
        ? originalError.message
        : String(originalError);
    super(`error with request ${detail}`, { cause: originalError });
    this.originalError = originalError;
    this.request = request;
  }
}

export class ResponseError extends RedditCoreError {
  readonly response: HttpResponse;
  readonly status: number;

  constructor(response: HttpResponse) {
    super(`received ${response.status} HTTP response`);
    this.response = response;
    this.status = response.status;
  }
}

export class BadJsonError extends ResponseError {}
export class BadRequestError extends ResponseError {}
export class ConflictError extends ResponseError {}
export class ForbiddenError extends ResponseError {}
export class InsufficientScopeError extends ResponseError {}
export class InvalidTokenError extends ResponseError {}
export class NotFoundError extends ResponseError {}
export class ServerError extends ResponseError {}
export class PayloadTooLargeError extends ResponseError {}
export class UriTooLongError extends ResponseError {}
export class UnavailableForLegalReasonsError extends ResponseError {}

export class RedirectError extends ResponseError {
  readonly path: string;

  constructor(response: HttpResponse) {
    const location = header(response, "location");
    if (location === null)
      throw new TypeError("Redirect response is missing a location header");

    const path = new URL(
      location,
      response.url ?? "https://reddit.invalid",
    ).pathname.replace(/\.json$/, "");
    const readOnlyHint = path.includes("/login/")
      ? " (You may be trying to perform a non-read-only action via a read-only instance.)"
      : "";
    super(response);
    this.message = `Redirect to ${path}${readOnlyHint}`;
    this.path = path;
  }
}

export interface SpecialErrorPayload {
  readonly message?: string;
  readonly reason?: string;
  readonly specialErrors?: readonly unknown[];
}

export class SpecialError extends ResponseError {
  readonly apiMessage: string;
  readonly reason: string;
  readonly specialErrors: readonly unknown[];

  constructor(response: HttpResponse, payload: SpecialErrorPayload = {}) {
    super(response);
    const responsePayload = response.json?.();
    const parsed =
      typeof responsePayload === "object" && responsePayload !== null
        ? (responsePayload as Record<string, unknown>)
        : {};
    this.apiMessage =
      payload.message ??
      (typeof parsed["message"] === "string" ? parsed["message"] : "");
    this.reason =
      payload.reason ??
      (typeof parsed["reason"] === "string" ? parsed["reason"] : "");
    const specialErrors = parsed["special_errors"];
    this.specialErrors =
      payload.specialErrors ??
      (Array.isArray(specialErrors)
        ? (specialErrors as readonly unknown[])
        : []);
    this.message = `Special error ${quoted(this.apiMessage)}`;
  }
}

export class TooManyRequestsError extends ResponseError {
  readonly retryAfter: string | null;
  readonly responseBody: string;

  constructor(response: HttpResponse) {
    super(response);
    this.retryAfter = header(response, "retry-after");
    this.responseBody =
      typeof response.body === "string"
        ? response.body
        : (response.text?.() ?? "");
    if (this.retryAfter !== null) {
      this.message += `. Please wait at least ${Number(this.retryAfter)} seconds before re-trying this request.`;
    }
  }
}
