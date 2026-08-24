import { describe, expect, it, vi } from "vitest";

import { Config } from "../src/config.js";
import type { Clock } from "../src/core/clock.js";
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from "../src/core/transport.js";
import { replayableText } from "../src/core/transport.js";
import { RedditApiError } from "../src/exceptions.js";
import {
  InfoListing,
  ListingRedditor,
  ListingSubreddit,
} from "../src/helpers.js";
import { Comment, Submission } from "../src/models/entities.js";
import { Reddit } from "../src/reddit.js";

function response(
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): TransportResponse {
  const body = JSON.stringify(value);
  return {
    body,
    headers,
    json: () => JSON.parse(body) as unknown,
    status: 200,
    statusText: "OK",
    text: () => body,
    url: "https://oauth.reddit.com/test",
  };
}

function setup(values: unknown[] = []): {
  reddit: Reddit;
  send: ReturnType<
    typeof vi.fn<(request: TransportRequest) => Promise<TransportResponse>>
  >;
} {
  const send = vi.fn<(request: TransportRequest) => Promise<TransportResponse>>(
    async () => response(values.shift()),
  );
  const transport: Transport = { send };
  const config = new Config(
    { clientId: "client", clientSecret: "secret", userAgent: "traw:test" },
    {},
  );
  return {
    reddit: new Reddit({
      config,
      transport,
      headerProvider: {
        headers: () => ({ "User-Agent": "traw:test" }),
        invalidate: () => undefined,
        readOnly: true,
      },
    }),
    send,
  };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("Reddit", () => {
  it("creates lazy model references synchronously, including URL references", () => {
    const { reddit } = setup();
    expect(reddit.comment("t1_comment")).toBeInstanceOf(Comment);
    expect(
      String(
        reddit.comment({
          url: "https://reddit.com/r/test/comments/post/title/comment/",
        }),
      ),
    ).toBe("comment");
    expect(String(reddit.submission({ url: "https://redd.it/post" }))).toBe(
      "post",
    );
    expect(reddit.subreddit("typescript")).toBeInstanceOf(ListingSubreddit);
    expect(reddit.redditor("spez")).toBeInstanceOf(ListingRedditor);
    expect(String(reddit.submission({ id: "direct" }))).toBe("direct");
    expect(
      String(
        reddit.submission({
          url: "https://reddit.com/r/x/comments/post/title",
        }),
      ),
    ).toBe("post");
    expect(String(reddit.comment({ url: "https://redd.it/comment" }))).toBe(
      "comment",
    );
    expect(reddit.domain("example.com").name).toBe("example.com");
    expect(() => reddit.comment({})).toThrow("Exactly one");
    expect(() => reddit.comment({ id: "a", url: "https://redd.it/a" })).toThrow(
      "Exactly one",
    );
    expect(() => reddit.comment({ url: "https://reddit.com/r/test" })).toThrow(
      "does not contain a comment ID",
    );
    expect(() => reddit.submission({ url: "not a URL" })).toThrow(TypeError);
  });

  it("adapts listing helpers into the expected request shape and models", async () => {
    const listing = {
      kind: "Listing",
      data: {
        after: null,
        children: [{ kind: "t3", data: { id: "post", title: "Post" } }],
      },
    };
    const { reddit, send } = setup([listing, listing]);
    const [front] = await collect(
      reddit.front.top({ limit: 1, timeFilter: "week" }),
    );
    const [subreddit] = await collect(
      reddit.subreddit("typescript").new({ limit: 1 }),
    );

    expect(front).toBeInstanceOf(Submission);
    expect(subreddit).toBeInstanceOf(Submission);
    expect(new URL(send.mock.calls[0]![0].url)).toMatchObject({
      pathname: "/top",
    });
    expect(
      Object.fromEntries(new URL(send.mock.calls[0]![0].url).searchParams),
    ).toMatchObject({ limit: "1", raw_json: "1", t: "week" });
    expect(new URL(send.mock.calls[1]![0].url).pathname).toBe(
      "/r/typescript/new",
    );
  });

  it("batches info fullnames by 100 and objectifies every batch", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `t3_${index}`);
    const page = (id: string) => ({
      kind: "Listing",
      data: {
        after: null,
        children: [{ kind: "t3", data: { id, title: id } }],
      },
    });
    const { reddit, send } = setup([page("first"), page("second")]);
    const listing = reddit.info({ fullnames: ids });
    const values = await collect(listing);

    expect(listing).toBeInstanceOf(InfoListing);
    expect(values.map(String)).toEqual(["first", "second"]);
    expect(
      new URL(send.mock.calls[0]![0].url).searchParams.get("id")?.split(","),
    ).toHaveLength(100);
    expect(new URL(send.mock.calls[1]![0].url).searchParams.get("id")).toBe(
      "t3_100",
    );
  });

  it("objectifies verb helpers and keeps request raw", async () => {
    const things = ["post", "get", "put", "patch", "delete"].map((id) => ({
      kind: "t3",
      data: { id, title: id },
    }));
    const rawThing = things[0];
    const { reddit, send } = setup(things);
    const raw = await reddit.request({
      method: "GET",
      path: "/raw",
      params: { absent: undefined, empty: null, ids: [1, 2], valid: false },
    });
    const model = await reddit.post("/api/test", { data: { value: 2 } });
    await reddit.put("/api/test", { json: { value: 3 } });
    await reddit.patch("/api/test", { data: { value: 4 } });
    await reddit.delete("/api/test", { params: { value: 5 } });

    expect(raw).toEqual(rawThing);
    expect(model).toBeInstanceOf(Submission);
    expect(send.mock.calls[0]![0].headers).toMatchObject({
      "User-Agent": "traw:test",
    });
    expect(String(send.mock.calls[1]![0].body?.create())).toBe(
      "value=2&api_type=json",
    );
    expect(send.mock.calls.map(([request]) => request.method)).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]);
    expect(
      Object.fromEntries(new URL(send.mock.calls[0]![0].url).searchParams),
    ).toMatchObject({ valid: "false" });
    expect(
      new URL(send.mock.calls[0]![0].url).searchParams.getAll("ids"),
    ).toEqual(["1", "2"]);
    expect(new URL(send.mock.calls[0]![0].url).searchParams.has("empty")).toBe(
      false,
    );
  });

  it("uses configured timeout and rate-limit window in default wiring", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutSignal);
    const fetchImplementation = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImplementation);
    const reddit = new Reddit({
      clientId: "client",
      clientSecret: null,
      headerProvider: { headers: () => ({}), invalidate: () => undefined },
      timeout: 2.5,
      userAgent: "traw:test",
      windowSize: 180,
    });
    await reddit.get("/timeout");
    expect(timeoutSpy).toHaveBeenCalledWith(2_500);
    expect(fetchImplementation.mock.calls[0]![1]!.signal).toBe(timeoutSignal);

    let now = 100_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const clock: Clock = { now: () => now, sleep };
    const send = vi
      .fn<(request: TransportRequest) => Promise<TransportResponse>>()
      .mockResolvedValueOnce(
        response(
          {},
          {
            "x-ratelimit-remaining": "60",
            "x-ratelimit-reset": "72",
            "x-ratelimit-used": "100",
          },
        ),
      )
      .mockResolvedValueOnce(response({}));
    const configured = new Reddit({
      clientId: "client",
      clientSecret: null,
      clock,
      headerProvider: { headers: () => ({}), invalidate: () => undefined },
      transport: { send },
      userAgent: "traw:test",
      windowSize: 180,
    });
    await configured.get("/first");
    await configured.get("/second");
    expect(sleep).toHaveBeenCalledWith(4_500, undefined);
  });

  it.each([
    ["2 milliseconds", 1_000],
    ["5 seconds", 6_000],
    ["1 minute", 61_000],
  ] as const)(
    "retries POST RATELIMIT responses reported in %s",
    async (reported, wait) => {
      const sleep = vi.fn(async () => undefined);
      const clock: Clock = { now: () => 0, sleep };
      const create = vi.fn(() => "payload");
      const send = vi.fn(async (request: TransportRequest) => {
        request.body?.create();
        return send.mock.calls.length < 2
          ? response({
              json: {
                errors: [
                  [
                    "RATELIMIT",
                    `You are doing that too much. Try again in ${reported}.`,
                    "ratelimit",
                  ],
                ],
              },
            })
          : response({ json: { errors: [] } });
      });
      const signal = new AbortController().signal;
      const reddit = new Reddit({
        clientId: "client",
        clientSecret: null,
        clock,
        headerProvider: { headers: () => ({}), invalidate: () => undefined },
        ratelimitSeconds: 60,
        transport: { send },
        userAgent: "traw:test",
      });
      await reddit.post("/api/test", {
        data: { ...replayableText("", "text/plain"), create },
        signal,
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]![0].body).toBe(send.mock.calls[1]![0].body);
      expect(send.mock.calls[0]![0].signal).toBe(signal);
      expect(send.mock.calls[1]![0].signal).toBe(signal);
      expect(sleep).toHaveBeenCalledWith(wait, signal);
    },
  );

  it("limits RATELIMIT handling to three POST attempts", async () => {
    const sleep = vi.fn(async () => undefined);
    const send = vi.fn(async () =>
      response({
        json: {
          errors: [["RATELIMIT", "Try again in 1 second.", "ratelimit"]],
        },
      }),
    );
    const reddit = new Reddit({
      clientId: "client",
      clientSecret: null,
      clock: { now: () => 0, sleep },
      headerProvider: { headers: () => ({}), invalidate: () => undefined },
      transport: { send },
      userAgent: "traw:test",
    });
    await expect(reddit.post("/api/test")).rejects.toBeInstanceOf(
      RedditApiError,
    );
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("finds a retryable RATELIMIT among unrelated and null-message errors", async () => {
    const sleep = vi.fn(async () => undefined);
    const send = vi
      .fn<(request: TransportRequest) => Promise<TransportResponse>>()
      .mockResolvedValueOnce(
        response({
          json: {
            errors: [
              ["OTHER", "Unrelated", "field"],
              ["RATELIMIT", null, "ratelimit"],
              ["RATELIMIT", "Try again in 1 second.", "ratelimit"],
            ],
          },
        }),
      )
      .mockResolvedValueOnce(response({}));
    const reddit = new Reddit({
      clientId: "client",
      clientSecret: null,
      clock: { now: () => 0, sleep },
      headerProvider: { headers: () => ({}), invalidate: () => undefined },
      transport: { send },
      userAgent: "traw:test",
    });
    await expect(reddit.post("/api/test")).resolves.toEqual({});
    expect(sleep).toHaveBeenCalledWith(2_000, undefined);
  });

  it.each(["Try again in 6 seconds.", "Some unexpected rate limit message."])(
    "does not retry an unsupported RATELIMIT response: %s",
    async (message) => {
      const sleep = vi.fn(async () => undefined);
      const send = vi.fn(async () =>
        response({ json: { errors: [["RATELIMIT", message, "ratelimit"]] } }),
      );
      const reddit = new Reddit({
        clientId: "client",
        clientSecret: null,
        clock: { now: () => 0, sleep },
        headerProvider: { headers: () => ({}), invalidate: () => undefined },
        transport: { send },
        userAgent: "traw:test",
      });
      await expect(reddit.post("/api/test")).rejects.toBeInstanceOf(
        RedditApiError,
      );
      expect(send).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("does not apply RATELIMIT retries to non-POST requests and aborts retry sleep", async () => {
    const payload = {
      json: {
        errors: [["RATELIMIT", "Try again in 1 second.", "ratelimit"]],
      },
    };
    const getSetup = setup([payload]);
    await expect(getSetup.reddit.get("/test")).rejects.toBeInstanceOf(
      RedditApiError,
    );
    expect(getSetup.send).toHaveBeenCalledOnce();

    const reason = new Error("cancelled");
    const controller = new AbortController();
    const sleep = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
      controller.abort(reason);
      throw signal?.reason;
    });
    const send = vi.fn(async () => response(payload));
    const reddit = new Reddit({
      clientId: "client",
      clientSecret: null,
      clock: { now: () => 0, sleep },
      headerProvider: { headers: () => ({}), invalidate: () => undefined },
      transport: { send },
      userAgent: "traw:test",
    });
    await expect(
      reddit.post("/api/test", { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(send).toHaveBeenCalledOnce();
  });

  it("reports read-only state, checks usernames, and closes an injected transport", async () => {
    const close = vi.fn();
    const send = vi.fn<
      (request: TransportRequest) => Promise<TransportResponse>
    >(async () => response(true));
    const config = new Config(
      { clientId: "client", clientSecret: "secret", userAgent: "traw:test" },
      {},
    );
    const reddit = new Reddit({
      config,
      headerProvider: {
        headers: () => ({ "User-Agent": "traw:test" }),
        invalidate: () => undefined,
        readOnly: true,
      },
      transport: { send, close },
    });

    expect(reddit.readOnly).toBe(true);
    expect(() => {
      reddit.readOnly = false;
    }).toThrow("cannot be changed");
    await expect(reddit.usernameAvailable("available")).resolves.toBe(true);
    expect(new URL(send.mock.calls[0]![0].url).searchParams.get("user")).toBe(
      "available",
    );
    await reddit.close();
    await reddit.close();
    expect(close).toHaveBeenCalledOnce();
    await expect(reddit.request({ method: "GET", path: "/" })).rejects.toThrow(
      "closed",
    );
  });

  it("supports credential options and mutable read-only providers", () => {
    let readOnly = true;
    const setReadOnly = vi.fn((value: boolean) => {
      readOnly = value;
    });
    const reddit = new Reddit({
      clientId: "client",
      clientSecret: null,
      userAgent: "traw:test",
      headerProvider: {
        headers: () => ({}),
        invalidate: () => undefined,
        get readOnly() {
          return readOnly;
        },
        setReadOnly,
      },
      transport: { send: vi.fn() },
    });

    reddit.readOnly = true;
    expect(setReadOnly).not.toHaveBeenCalled();
    reddit.readOnly = false;
    expect(reddit.readOnly).toBe(false);
    expect(setReadOnly).toHaveBeenCalledWith(false);
    expect(
      new Reddit({
        clientId: "client",
        clientSecret: null,
        userAgent: "traw:test",
        headerProvider: { headers: () => ({}), invalidate: () => undefined },
        transport: { send: vi.fn() },
      }).readOnly,
    ).toBe(true);
  });

  it("validates constructor dependencies and username responses", async () => {
    const controller = new AbortController();
    const { reddit, send } = setup([false, "yes"]);
    await expect(
      reddit.usernameAvailable("taken", controller.signal),
    ).resolves.toBe(false);
    expect(send.mock.calls[0]![0].signal).toBe(controller.signal);
    await expect(reddit.usernameAvailable("bad")).rejects.toThrow(
      "non-boolean",
    );
  });

  it("closes transports without a close hook", async () => {
    const { reddit } = setup();
    await expect(reddit.close()).resolves.toBeUndefined();
    await expect(reddit.close()).resolves.toBeUndefined();
  });
});
