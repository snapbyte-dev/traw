import { describe, expect, it, vi } from "vitest";

import { FetchTransport } from "../../src/core/fetch-transport.js";
import { replayableText } from "../../src/core/transport.js";
import { RequestError } from "../../src/exceptions.js";

describe("FetchTransport", () => {
  it("buffers a response and creates the body for each send", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async () =>
        new Response('{"ok":true}', {
          headers: { "x-test": "yes" },
          status: 200,
        }),
    );
    const create = vi.fn(() => "payload");
    const transport = new FetchTransport(fetchImplementation);
    const request = {
      body: { ...replayableText("", "text/plain"), create },
      method: "POST",
      url: "https://example.com/",
    };
    const first = await transport.send(request);
    await transport.send(request);
    expect(create).toHaveBeenCalledTimes(2);
    expect(first.json()).toEqual({ ok: true });
    expect(first.headers["x-test"]).toBe("yes");
  });

  it("preserves explicit content types and forwards signals", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async () => new Response("ok", { status: 201, statusText: "Created" }),
    );
    const signal = new AbortController().signal;
    const result = await new FetchTransport(fetchImplementation).send({
      body: replayableText("payload", "application/json"),
      headers: { "Content-Type": "custom/type" },
      method: "PUT",
      signal,
      url: "https://example.com/resource",
    });
    const init = fetchImplementation.mock.calls[0]![1]!;
    expect((init.headers as Headers).get("content-type")).toBe("custom/type");
    expect(init).toMatchObject({ method: "PUT", redirect: "manual", signal });
    expect(result.text()).toBe("ok");
    expect(result.statusText).toBe("Created");
  });

  it("composes configured timeouts with caller cancellation", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      receivedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const transport = new FetchTransport(fetchImplementation, {
      timeoutMs: 250,
    });
    const request = transport.send({
      method: "GET",
      signal: caller.signal,
      url: "https://example.com/",
    });
    const reason = new DOMException("timed out", "TimeoutError");
    timeout.abort(reason);

    const error = await request.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ originalError: reason });
    expect(transport.isRetryableError(error)).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(250);
    expect(receivedSignal).not.toBe(caller.signal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("uses a configured timeout without requiring a caller signal", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetchImplementation = vi.fn<typeof fetch>(
      async () => new Response("ok"),
    );
    await new FetchTransport(fetchImplementation, { timeoutMs: 10 }).send({
      method: "GET",
      url: "https://example.com/",
    });
    expect(fetchImplementation.mock.calls[0]![1]!.signal).toBe(timeout.signal);
  });

  it("preserves caller abort reasons in a composed timeout signal", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    const caller = new AbortController();
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const pending = new FetchTransport(fetchImplementation, {
      timeoutMs: 10,
    }).send({
      method: "GET",
      signal: caller.signal,
      url: "https://example.com/",
    });
    const reason = new Error("cancelled");
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("wraps fetch and response buffering failures", async () => {
    const failure = new TypeError("offline");
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw failure;
    });
    const error = await new FetchTransport(fetchImplementation)
      .send({ method: "GET", url: "https://example.com/" })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ originalError: failure });
    expect(
      new FetchTransport(fetchImplementation).isRetryableError(error),
    ).toBe(false);
  });

  it("marks errors produced by that transport as retryable", async () => {
    const transport = new FetchTransport(async () => {
      throw new TypeError("offline");
    });
    const error = await transport
      .send({ method: "GET", url: "https://example.com/" })
      .catch((value: unknown) => value);
    expect(transport.isRetryableError(error)).toBe(true);
    expect(transport.isRetryableError(null)).toBe(false);
  });

  it("rethrows the abort reason without wrapping it", async () => {
    const reason = new Error("cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      new FetchTransport(fetchImplementation).send({
        method: "GET",
        signal: controller.signal,
        url: "https://example.com/",
      }),
    ).rejects.toBe(reason);
  });

  it("falls back to the transport error when an aborted signal has no reason", async () => {
    const failure = new Error("abort without reason");
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw failure;
    });
    const signal = { aborted: true, reason: undefined } as AbortSignal;
    await expect(
      new FetchTransport(fetchImplementation).send({
        method: "GET",
        signal,
        url: "https://example.com/",
      }),
    ).rejects.toBe(failure);
  });
});
