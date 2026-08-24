import { describe, expect, it, vi } from "vitest";

import {
  BadJsonError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InvalidTokenError,
  NotFoundError,
  RedirectError,
  RequestError,
  ResponseError,
  ServerError,
  SpecialError,
  PayloadTooLargeError,
  TooManyRequestsError,
  UriTooLongError,
  UnavailableForLegalReasonsError,
} from "../../src/exceptions.js";
import type { Clock } from "../../src/core/clock.js";
import { Session } from "../../src/core/session.js";
import {
  replayableText,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "../../src/core/transport.js";

function response(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): TransportResponse {
  const text = value === undefined ? "" : JSON.stringify(value);
  return {
    body: text,
    headers,
    json: () => JSON.parse(text) as unknown,
    status,
    statusText: "",
    text: () => text,
    url: "https://oauth.reddit.com/test",
  };
}

function setup(responses: TransportResponse[]): {
  session: Session;
  send: ReturnType<
    typeof vi.fn<(request: TransportRequest) => Promise<TransportResponse>>
  >;
} {
  const send = vi.fn<(request: TransportRequest) => Promise<TransportResponse>>(
    async () => responses.shift()!,
  );
  const transport: Transport = {
    isRetryableError: (error) => error instanceof RequestError,
    send,
  };
  const clock: Clock = { now: () => 0, sleep: vi.fn(async () => undefined) };
  return {
    send,
    session: new Session({
      baseUrl: "https://oauth.reddit.com",
      clock,
      random: () => 0,
      transport,
    }),
  };
}

describe("Session", () => {
  it("adds raw_json and api_type without mutating input and replays forms", async () => {
    const { send, session } = setup([
      response(500, {}),
      response(200, { ok: true }),
    ]);
    const data = { title: "hello" };
    await session.request({
      data,
      method: "POST",
      path: "/api/submit",
      params: { limit: 10 },
    });
    expect(data).toEqual({ title: "hello" });
    const requests = send.mock.calls.map((call) => call[0] as TransportRequest);
    expect(new URL(requests[0]!.url).searchParams.get("raw_json")).toBe("1");
    expect(String(requests[0]!.body!.create())).toBe(
      "title=hello&api_type=json",
    );
    expect(String(requests[1]!.body!.create())).toBe(
      "title=hello&api_type=json",
    );
  });

  it("invalidates headers and retries a 401 up to three total attempts", async () => {
    const { send, session: baseSession } = setup([]);
    const invalidate = vi.fn();
    const headers = vi.fn(() => ({ Authorization: "bearer token" }));
    const session = new Session({
      baseUrl: "https://oauth.reddit.com",
      headerProvider: { canRefresh: () => true, headers, invalidate },
      transport: { send },
    });
    send
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValueOnce(response(200, { ok: true }));
    await expect(
      session.request({ method: "GET", path: "/" }),
    ).resolves.toEqual({ ok: true });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(headers).toHaveBeenCalledTimes(2);
    expect(baseSession).toBeDefined();
  });

  it("supports validated typed response parsing", async () => {
    const { session } = setup([response(200, { count: 3 })]);
    const count = await session.request({
      method: "GET",
      parse: (result) => {
        const value = result.json();
        if (
          typeof value !== "object" ||
          value === null ||
          !("count" in value) ||
          typeof value.count !== "number"
        ) {
          throw new TypeError("invalid response");
        }
        return value.count;
      },
      path: "/count",
    });
    expect(count).toBe(3);
  });

  it("makes three attempts for transport failures", async () => {
    const { send, session } = setup([]);
    send.mockRejectedValue(new RequestError(new TypeError("network failed")));
    await expect(
      session.request({ method: "GET", path: "/" }),
    ).rejects.toBeInstanceOf(RequestError);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry unrelated transport errors", async () => {
    const { send, session } = setup([]);
    const failure = new TypeError("programmer error");
    send.mockRejectedValue(failure);
    await expect(session.request({ method: "GET", path: "/" })).rejects.toBe(
      failure,
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not retry an ineligible RequestError", async () => {
    const failure = new RequestError(new Error("not retryable"));
    const send = vi.fn(async () => {
      throw failure;
    });
    const session = new Session({
      baseUrl: "https://oauth.reddit.com",
      transport: { isRetryableError: () => false, send },
    });
    await expect(session.request({ method: "GET", path: "/" })).rejects.toBe(
      failure,
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([408, 500, 502, 503, 504, 520, 522])(
    "retries explicit HTTP status %i",
    async (status) => {
      const { send, session } = setup([
        response(status, {}),
        response(200, { ok: true }),
      ]);
      await expect(
        session.request({ method: "GET", path: "/" }),
      ).resolves.toEqual({ ok: true });
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it.each([501, 505, 519, 521, 523, 599])(
    "does not retry unlisted server status %i",
    async (status) => {
      const { send, session } = setup([response(status, {})]);
      await expect(
        session.request({ method: "GET", path: "/" }),
      ).rejects.toBeInstanceOf(ServerError);
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it("serializes arrays, scalars, JSON variants, and replayable bodies", async () => {
    const { send, session } = setup([
      response(200, {}),
      response(200, {}),
      response(200, {}),
      response(200, {}),
      response(200, {}),
    ]);
    await session.request({
      data: { enabled: true, tag: ["one", "two"] },
      method: "POST",
      params: { page: [1, 2] },
      path: "/form",
    });
    await session.request({
      json: { value: 1 },
      method: "POST",
      path: "/object",
    });
    await session.request({ json: [1, null], method: "POST", path: "/array" });
    await session.request({ json: "value", method: "POST", path: "/scalar" });
    const replayable = replayableText("raw", "text/plain");
    await session.request({ data: replayable, method: "POST", path: "/raw" });
    const requests = send.mock.calls.map(([request]) => request);
    expect(new URL(requests[0]!.url).searchParams.getAll("page")).toEqual([
      "1",
      "2",
    ]);
    expect(String(requests[0]!.body!.create())).toBe(
      "enabled=true&tag=one&tag=two&api_type=json",
    );
    expect(
      requests.slice(1, 4).map((request) => request.body!.create()),
    ).toEqual(['{"value":1,"api_type":"json"}', "[1,null]", '"value"']);
    expect(requests[4]!.body).toBe(replayable);
  });

  it("rejects simultaneous form and JSON bodies before transport", async () => {
    const { send, session } = setup([]);
    await expect(
      session.request({ data: {}, json: {}, method: "POST", path: "/" }),
    ).rejects.toThrow("data and json cannot both be provided");
    expect(send).not.toHaveBeenCalled();
  });

  it("merges headers in provider precedence and forwards the signal", async () => {
    const send = vi.fn<
      (request: TransportRequest) => Promise<TransportResponse>
    >(async () => response(200, {}));
    const signal = new AbortController().signal;
    const session = new Session({
      baseUrl: "https://oauth.reddit.com/api",
      headerProvider: {
        headers: async () => ({ shared: "provider", injected: "yes" }),
        invalidate: vi.fn(),
      },
      headers: { base: "yes", shared: "base" },
      transport: { send },
    });
    await session.request({
      headers: { request: "yes", shared: "request" },
      method: "GET",
      path: "child",
      signal,
    });
    expect(send.mock.calls[0]![0]).toMatchObject({
      headers: {
        base: "yes",
        injected: "yes",
        request: "yes",
        shared: "provider",
      },
      signal,
      url: "https://oauth.reddit.com/api/child?raw_json=1",
    });
  });

  it("can omit OAuth headers and raw_json for an external upload", async () => {
    const send = vi.fn<
      (request: TransportRequest) => Promise<TransportResponse>
    >(async () => response(204, undefined));
    const headers = vi.fn(() => ({ Authorization: "bearer token" }));
    const session = new Session({
      baseUrl: "https://oauth.reddit.com",
      headerProvider: { headers, invalidate: vi.fn() },
      headers: { "User-Agent": "traw:test" },
      transport: { send },
    });

    await session.request({
      auth: false,
      method: "POST",
      path: "https://bucket.example/upload",
      rawJson: false,
    });

    expect(headers).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![0]).toMatchObject({
      headers: { "User-Agent": "traw:test" },
      url: "https://bucket.example/upload",
    });
  });

  it("returns successful non-JSON upload responses as text", async () => {
    const xml = "<PostResponse><Key>asset</Key></PostResponse>";
    const result = {
      ...response(201, undefined),
      body: xml,
      text: () => xml,
    };
    const { session } = setup([result]);

    await expect(
      session.request({
        method: "POST",
        path: "https://bucket.example/upload",
        responseType: "text",
      }),
    ).resolves.toBe(xml);
  });

  it("handles no-content, empty, and malformed default bodies", async () => {
    const emptyByHeader = {
      ...response(200, undefined, { "content-length": "0" }),
      body: "ignored",
    };
    const malformed = {
      ...response(200, "not json"),
      body: "{",
      json: () => {
        throw new SyntaxError("bad JSON");
      },
    };
    const { session } = setup([
      response(204, undefined),
      emptyByHeader,
      response(200, undefined),
      malformed,
    ]);
    await expect(
      session.request({ method: "GET", path: "/204" }),
    ).resolves.toBeNull();
    await expect(
      session.request({ method: "GET", path: "/header-empty" }),
    ).resolves.toBe("");
    await expect(
      session.request({ method: "GET", path: "/body-empty" }),
    ).resolves.toBe("");
    await expect(
      session.request({ method: "GET", path: "/bad" }),
    ).rejects.toBeInstanceOf(BadJsonError);
  });

  it.each([
    [301, RedirectError],
    [302, RedirectError],
    [400, BadRequestError],
    [401, InvalidTokenError],
    [403, ForbiddenError],
    [404, NotFoundError],
    [409, ConflictError],
    [413, PayloadTooLargeError],
    [414, UriTooLongError],
    [429, TooManyRequestsError],
    [451, UnavailableForLegalReasonsError],
    [500, ServerError],
    [599, ServerError],
    [418, ResponseError],
  ] as const)("maps HTTP %i to %s", async (status, Exception) => {
    const headers =
      status === 301 || status === 302 ? { location: "/destination.json" } : {};
    const { session } = setup([
      response(status, {}, headers),
      response(status, {}, headers),
      response(status, {}, headers),
    ]);
    await expect(
      session.request({ method: "GET", path: "/" }),
    ).rejects.toBeInstanceOf(Exception);
  });

  it("parses structured and malformed special errors", async () => {
    const structured = setup([
      response(415, {
        message: "media failed",
        reason: "format",
        special_errors: ["x"],
      }),
    ]);
    const error = await structured.session
      .request({ method: "GET", path: "/" })
      .catch((value: unknown) => value);
    expect(error).toMatchObject<Partial<SpecialError>>({
      apiMessage: "media failed",
      reason: "format",
      specialErrors: ["x"],
    });

    const bad = {
      ...response(415, {}),
      json: () => {
        throw new SyntaxError("bad JSON");
      },
    };
    await expect(
      setup([bad]).session.request({ method: "GET", path: "/" }),
    ).rejects.toBeInstanceOf(SpecialError);
  });

  it("invalidates and surfaces a final unauthorized response", async () => {
    const invalidate = vi.fn();
    const send = vi.fn(async () => response(401, {}));
    const session = new Session({
      attempts: 1,
      baseUrl: "https://oauth.reddit.com",
      headerProvider: { headers: () => ({}), invalidate },
      transport: { send },
    });
    await expect(
      session.request({ method: "GET", path: "/" }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("surfaces 401 without retry when the active authorization cannot refresh", async () => {
    const invalidate = vi.fn();
    const send = vi.fn(async () => response(401, {}));
    const session = new Session({
      baseUrl: "https://oauth.reddit.com",
      headerProvider: {
        canRefresh: () => false,
        headers: () => ({ Authorization: "bearer implicit" }),
        invalidate,
      },
      transport: { send },
    });
    await expect(
      session.request({ method: "GET", path: "/" }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    expect(send).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
