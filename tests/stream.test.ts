import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSleep, streamGenerator } from "../src/stream.js";

interface Item {
  fullname: string;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("streamGenerator", () => {
  it("yields newest-first responses oldest first and deduplicates", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([
        { fullname: "3" },
        { fullname: "2" },
        { fullname: "1" },
      ])
      .mockResolvedValueOnce([
        { fullname: "4" },
        { fullname: "3" },
        { fullname: "2" },
      ]);
    const stream = streamGenerator<Item>(fetch, {
      pauseAfter: 0,
      sleep: vi.fn(),
    });

    expect((await stream.next()).value).toEqual({ fullname: "1" });
    expect((await stream.next()).value).toEqual({ fullname: "2" });
    expect((await stream.next()).value).toEqual({ fullname: "3" });
    expect((await stream.next()).value).toEqual({ fullname: "4" });
    expect(fetch).toHaveBeenNthCalledWith(2, { before: "3", limit: 100 });
    await stream.return(undefined);
  });

  it("supports skip-existing, custom attributes, continue cursors, and async sources", async () => {
    async function* source(): AsyncGenerator<{ id: string }> {
      yield { id: "new" };
      yield { id: "old" };
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([{ id: "existing" }])
      .mockResolvedValueOnce(source());
    const stream = streamGenerator(fetch, {
      attribute: "id",
      continueAfterId: "resume-here",
      pauseAfter: 0,
      skipExisting: true,
    });

    expect((await stream.next()).value).toEqual({ id: "old" });
    expect(fetch).toHaveBeenNthCalledWith(1, {
      before: "resume-here",
      limit: 100,
    });
    expect(fetch).toHaveBeenNthCalledWith(2, {
      before: "existing",
      limit: 100,
    });
    await stream.return(undefined);
  });

  it("omits before when excludeBefore is set and forwards AbortSignal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue([{ fullname: "one" }]);
    const stream = streamGenerator<Item>(fetch, {
      continueAfterId: "cursor",
      excludeBefore: true,
      signal: controller.signal,
    });
    expect((await stream.next()).value).toEqual({ fullname: "one" });
    expect(fetch).toHaveBeenCalledWith({
      limit: 100,
      signal: controller.signal,
    });
    await stream.return(undefined);
  });

  it("decrements cursorless request limits and wraps after thirty polls", async () => {
    const fetch = vi.fn().mockResolvedValue([]);
    const stream = streamGenerator<Item>(fetch, { pauseAfter: -1 });
    for (let index = 0; index < 31; index += 1) {
      expect((await stream.next()).value).toBeNull();
    }
    expect(fetch.mock.calls[0]?.[0]).toEqual({ limit: 100 });
    expect(fetch.mock.calls[29]?.[0]).toEqual({ limit: 71 });
    expect(fetch.mock.calls[30]?.[0]).toEqual({ limit: 100 });
    await stream.return(undefined);
  });

  it("yields a negative-pause sentinel even after yielding found items", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([{ fullname: "one" }])
      .mockResolvedValueOnce([]);
    const stream = streamGenerator<Item>(fetch, { pauseAfter: -1 });
    expect((await stream.next()).value).toEqual({ fullname: "one" });
    expect((await stream.next()).value).toBeNull();
    await stream.return(undefined);
  });

  it("implements zero and positive pause thresholds", async () => {
    const immediate = streamGenerator<Item>(async () => [], { pauseAfter: 0 });
    expect((await immediate.next()).value).toBeNull();
    await immediate.return(undefined);

    const sleep = vi.fn(async () => undefined);
    const delayed = streamGenerator<Item>(async () => [], {
      pauseAfter: 1,
      random: () => 0.5,
      sleep,
    });
    expect((await delayed.next()).value).toBeNull();
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
    await delayed.return(undefined);
  });

  it("reports errors, applies exponential jittered backoff, and caps it", async () => {
    const failures = Array.from(
      { length: 6 },
      (_, index) => new Error(`failure ${index}`),
    );
    const fetch = vi.fn();
    for (const failure of failures) fetch.mockRejectedValueOnce(failure);
    fetch.mockResolvedValueOnce([{ fullname: "recovered" }]);
    const onError = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const stream = streamGenerator<Item>(fetch, {
      onError,
      random: () => 0.5,
      sleep,
    });

    expect((await stream.next()).value).toEqual({ fullname: "recovered" });
    expect((onError.mock.calls as unknown[][]).map(([error]) => error)).toEqual(
      failures,
    );
    expect(
      (sleep.mock.calls as unknown[][]).map(([milliseconds]) => milliseconds),
    ).toEqual([1000, 2000, 4000, 8000, 16000, 16000]);
    await stream.return(undefined);
  });

  it("uses both ends of the jitter range", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce([{ fullname: "ok" }]);
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1);
    const sleep = vi.fn(async () => undefined);
    const stream = streamGenerator<Item>(fetch, {
      onError: vi.fn(),
      random,
      sleep,
    });
    await stream.next();
    expect(
      (sleep.mock.calls as unknown[][]).map(([milliseconds]) => milliseconds),
    ).toEqual([968.75, 2062.5]);
    await stream.return(undefined);
  });

  it("rethrows fetch errors when no handler is configured", async () => {
    const failure = new Error("request failed");
    const stream = streamGenerator<Item>(async () => Promise.reject(failure));
    await expect(stream.next()).rejects.toBe(failure);
  });

  it("rejects invalid seen capacities", async () => {
    for (const seenCapacity of [0, -1, 1.5]) {
      const stream = streamGenerator<Item>(async () => [], { seenCapacity });
      await expect(stream.next()).rejects.toThrow(
        "seenCapacity must be a positive integer",
      );
    }
  });

  it("evicts least-recently-seen IDs and refreshes duplicate recency", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([{ fullname: "a" }, { fullname: "b" }])
      .mockResolvedValueOnce([{ fullname: "c" }, { fullname: "a" }])
      .mockResolvedValueOnce([{ fullname: "b" }]);
    const stream = streamGenerator<Item>(fetch, {
      pauseAfter: 0,
      seenCapacity: 2,
    });

    expect((await stream.next()).value).toEqual({ fullname: "b" });
    expect((await stream.next()).value).toEqual({ fullname: "a" });
    expect((await stream.next()).value).toEqual({ fullname: "c" });
    expect((await stream.next()).value).toEqual({ fullname: "b" });
    await stream.return(undefined);
  });

  it.each([
    [42, "Stream items must be objects"],
    [{ fullname: 42 }, "Stream item attribute fullname must be a string"],
    [{ other: "value" }, "Stream item attribute fullname must be a string"],
  ])("rejects malformed stream item %#", async (item, message) => {
    const stream = streamGenerator(async () => [item]);
    await expect(stream.next()).rejects.toThrow(message);
  });

  it("checks pre-existing cancellation before fetching", async () => {
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);
    const fetch = vi.fn();
    const stream = streamGenerator<Item>(fetch, { signal: controller.signal });
    await expect(stream.next()).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not route cancellation during fetch through the retry handler", async () => {
    const controller = new AbortController();
    const onError = vi.fn();
    const stream = streamGenerator<Item>(
      async () => {
        controller.abort("cancelled");
        throw new Error("request stopped");
      },
      { onError, signal: controller.signal },
    );
    await expect(stream.next()).rejects.toBe("cancelled");
    expect(onError).not.toHaveBeenCalled();
  });

  it("propagates cancellation from injected sleep", async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
      controller.abort("stop");
      signal?.throwIfAborted();
    });
    const stream = streamGenerator<Item>(async () => [], {
      random: () => 0.5,
      signal: controller.signal,
      sleep,
    });
    await expect(stream.next()).rejects.toBe("stop");
    expect(sleep).toHaveBeenCalledWith(1000, controller.signal);
  });
});

describe("defaultSleep", () => {
  it("resolves after the requested zero delay", async () => {
    vi.useFakeTimers();
    const promise = defaultSleep(0);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    const reason = new Error("pre-aborted");
    controller.abort(reason);
    await expect(defaultSleep(10, controller.signal)).rejects.toBe(reason);
  });

  it("rejects an active sleep with the signal Error reason", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("cancel timer");
    const promise = defaultSleep(100, controller.signal);
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("creates an AbortError when cancellation has a non-Error reason", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = defaultSleep(100, controller.signal);
    controller.abort("stop");
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
