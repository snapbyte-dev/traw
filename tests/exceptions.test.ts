import { describe, expect, it, vi } from "vitest";

import {
  BadJsonError,
  BadRequestError,
  ClientError,
  ConflictError,
  DuplicateReplaceError,
  ForbiddenError,
  InsufficientScopeError,
  InvalidFlairTemplateIdError,
  InvalidImplicitAuthError,
  InvalidInvocationError,
  InvalidTokenError,
  InvalidUrlError,
  MediaPostFailedError,
  MissingRequiredAttributeError,
  NotFoundError,
  OAuthError,
  TrawError,
  RedditCoreError,
  ReadOnlyError,
  RedirectError,
  RedditApiError,
  RedditErrorItem,
  RequestError,
  ServerError,
  SpecialError,
  PayloadTooLargeError,
  MediaTooLargeError,
  TooManyRequestsError,
  UriTooLongError,
  UnavailableForLegalReasonsError,
  WebSocketError,
  type HttpResponse,
  type RedditError,
} from "../src/exceptions.js";

describe("client exceptions", () => {
  it("sets concrete names and fixed constructor messages", () => {
    const duplicate = new DuplicateReplaceError();
    expect(duplicate).toBeInstanceOf(ClientError);
    expect(duplicate).toBeInstanceOf(TrawError);
    expect(duplicate.name).toBe("DuplicateReplaceError");
    expect(duplicate.message).toContain("replace_more_comments");
    expect(new InvalidImplicitAuthError().message).toBe(
      "Implicit authorization can only be used with installed apps.",
    );
    expect(new MediaPostFailedError().message).toContain(
      "media upload action has failed",
    );
  });

  it("preserves constructor-specific values and formats messages", () => {
    const flair = new InvalidFlairTemplateIdError("template-1");
    const url = new InvalidUrlError("bad://url");
    const alternateUrl = new InvalidUrlError("value", "{} then {0}");
    const media = new MediaTooLargeError({ actual: 11, maximumSize: 10 });

    expect(flair.templateId).toBe("template-1");
    expect(flair.message).toContain("'template-1' is invalid");
    expect(url.url).toBe("bad://url");
    expect(url.message).toBe("Invalid URL: bad://url");
    expect(alternateUrl.message).toBe("value then value");
    expect(media).toMatchObject({ actual: 11, maximumSize: 10 });
    expect(media.message).toContain(
      "maximum size is 10 bytes, uploaded 11 bytes",
    );
  });

  it("supports inherited message constructors", () => {
    expect(new MissingRequiredAttributeError("missing").message).toBe(
      "missing",
    );
    expect(new ReadOnlyError("read only").name).toBe("ReadOnlyError");
    expect(new WebSocketError("socket").name).toBe("WebSocketError");
  });
});

describe("Reddit API errors", () => {
  it("parses a single item, one tuple, and mixed error lists", () => {
    const item = new RedditErrorItem("ONE");
    const single = new RedditApiError(item);
    const tuple = new RedditApiError(["BAD_FIELD", "invalid", "title"]);
    const existing = new RedditErrorItem("RATELIMIT", { message: "slow down" });
    const errors: readonly RedditError[] = [
      ["BAD_FIELD", "", ""],
      ["EMPTY"],
      existing,
    ];
    const mixed = new RedditApiError(errors);

    expect(single.items).toEqual([item]);
    expect(tuple.message).toBe("BAD_FIELD: 'invalid' on field 'title'");
    expect(mixed.items[0]).toEqual(new RedditErrorItem("BAD_FIELD"));
    expect(mixed.items[1]).toEqual(new RedditErrorItem("EMPTY"));
    expect(mixed.items[2]).toBe(existing);
  });

  it("quotes slashes and apostrophes and omits null details", () => {
    const item = new RedditErrorItem("BAD", {
      field: "author's",
      message: "a\\b",
    });
    expect(item.errorMessage).toBe("BAD: 'a\\\\b' on field 'author\\'s'");
    expect(item.toString()).toBe(item.errorMessage);
    expect(
      new RedditErrorItem("PLAIN", { field: null, message: null }).errorMessage,
    ).toBe("PLAIN");
  });

  it("implements value equality across every field", () => {
    const item = new RedditErrorItem("BAD", {
      field: "name",
      message: "wrong",
    });
    expect(
      item.equals(
        new RedditErrorItem("BAD", { field: "name", message: "wrong" }),
      ),
    ).toBe(true);
    expect(item.equals({})).toBe(false);
    expect(
      item.equals(
        new RedditErrorItem("OTHER", { field: "name", message: "wrong" }),
      ),
    ).toBe(false);
    expect(
      item.equals(
        new RedditErrorItem("BAD", { field: "name", message: "other" }),
      ),
    ).toBe(false);
    expect(
      item.equals(
        new RedditErrorItem("BAD", { field: "other", message: "wrong" }),
      ),
    ).toBe(false);
  });
});

describe("transport exceptions", () => {
  it("preserves OAuth metadata with and without descriptions", () => {
    const response = { status: 401 };
    const described = new OAuthError(response, "invalid_grant", "expired code");
    const plain = new OAuthError(response, "invalid_grant");
    expect(described).toMatchObject({
      description: "expired code",
      error: "invalid_grant",
      message: "invalid_grant error processing request (expired code)",
      response,
    });
    expect(plain.message).toBe("invalid_grant error processing request");
    expect(described).toBeInstanceOf(RedditCoreError);
    expect(described).not.toBeInstanceOf(ClientError);
  });

  it("preserves request causes and handles non-Error causes and default metadata", () => {
    const cause = new Error("socket closed");
    const request = new RequestError(cause, {
      method: "GET",
      url: "https://example.com",
    });
    const scalar = new RequestError(42);
    expect(request.cause).toBe(cause);
    expect(request.originalError).toBe(cause);
    expect(request.request.method).toBe("GET");
    expect(scalar.message).toBe("error with request 42");
    expect(scalar.request).toEqual({});
  });

  it("preserves response and status for every status exception subtype", () => {
    const response = { status: 503 };
    const constructors = [
      BadJsonError,
      BadRequestError,
      ConflictError,
      ForbiddenError,
      InsufficientScopeError,
      InvalidTokenError,
      NotFoundError,
      ServerError,
      PayloadTooLargeError,
      UriTooLongError,
      UnavailableForLegalReasonsError,
    ];
    for (const Constructor of constructors) {
      const error = new Constructor(response);
      expect(error.response).toBe(response);
      expect(error.status).toBe(503);
      expect(error.message).toBe("received 503 HTTP response");
      expect(error.name).toBe(Constructor.name);
    }
    expect(new InvalidInvocationError("bad call").message).toBe("bad call");
  });
});

describe("special response exceptions", () => {
  it("reads redirects from record headers and strips .json", () => {
    const redirect = new RedirectError({
      status: 302,
      url: "https://www.reddit.com",
      headers: { Location: "https://www.reddit.com/r/typescript.json" },
    });
    expect(redirect.path).toBe("/r/typescript");
    expect(redirect.message).toBe("Redirect to /r/typescript");
  });

  it("reads relative redirects through Headers-like objects and adds the login hint", () => {
    const get = vi.fn((name: string) =>
      name === "location" ? "/login/test.json" : null,
    );
    const redirect = new RedirectError({ status: 301, headers: { get } });
    expect(get).toHaveBeenCalledWith("location");
    expect(redirect.path).toBe("/login/test");
    expect(redirect.message).toContain("non-read-only action");
  });

  it("rejects redirects without a usable location", () => {
    expect(() => new RedirectError({ status: 302 })).toThrow(
      "Redirect response is missing a location header",
    );
    expect(
      () =>
        new RedirectError({ status: 302, headers: { get: () => 42 } as never }),
    ).toThrow("Redirect response is missing a location header");
    expect(
      () =>
        new RedirectError({ status: 302, headers: { location: 42 } as never }),
    ).toThrow("Redirect response is missing a location header");
  });

  it("uses explicit special-error payload fields before response JSON", () => {
    const json = vi.fn(() => ({
      message: "from response",
      reason: "response reason",
      special_errors: ["response"],
    }));
    const response = { status: 400, json };
    const error = new SpecialError(response, {
      message: "explicit",
      reason: "explicit reason",
      specialErrors: ["explicit"],
    });
    expect(error).toMatchObject({
      apiMessage: "explicit",
      reason: "explicit reason",
      specialErrors: ["explicit"],
      message: "Special error 'explicit'",
    });
    expect(json).toHaveBeenCalledOnce();
  });

  it("parses special-error response JSON and safely defaults malformed fields", () => {
    const parsed = new SpecialError({
      status: 400,
      json: () => ({ message: "bad", reason: "why", special_errors: [1, 2] }),
    });
    const malformed = new SpecialError({
      status: 400,
      json: () => "not an object",
    });
    const absent = new SpecialError({ status: 400 });
    expect(parsed).toMatchObject({
      apiMessage: "bad",
      reason: "why",
      specialErrors: [1, 2],
    });
    expect(malformed).toMatchObject({
      apiMessage: "",
      reason: "",
      specialErrors: [],
    });
    expect(absent.specialErrors).toEqual([]);
  });

  it("extracts retry metadata case-insensitively and prefers string bodies", () => {
    const text = vi.fn(() => "from text");
    const body = new TooManyRequestsError({
      status: 429,
      body: "slow down",
      headers: { "Retry-After": "2.5" },
      text,
    });
    expect(body.retryAfter).toBe("2.5");
    expect(body.responseBody).toBe("slow down");
    expect(body.message).toContain("at least 2.5 seconds");
    expect(text).not.toHaveBeenCalled();
  });

  it("falls back to text and handles absent or undefined record headers", () => {
    const response: HttpResponse = {
      status: 429,
      headers: { unrelated: undefined },
      text: () => "text response",
    };
    const limited = new TooManyRequestsError(response);
    expect(limited.retryAfter).toBeNull();
    expect(limited.responseBody).toBe("text response");
    expect(limited.message).toBe("received 429 HTTP response");
    expect(new TooManyRequestsError({ status: 429 }).responseBody).toBe("");
  });
});
