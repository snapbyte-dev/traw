import { describe, expect, it, vi } from "vitest";

import type { Clock } from "../../src/core/clock.js";
import { RetryStrategy, retry } from "../../src/core/retry.js";

describe("retry", () => {
  it("makes three attempts with prawcore-compatible jitter", async () => {
    const sleep = vi.fn(async () => undefined);
    const clock: Clock = { now: () => 0, sleep };
    const operation = vi.fn(async () => {
      throw new Error("temporary");
    });
    await expect(
      retry(operation, () => true, { clock, random: () => 0.5 }),
    ).rejects.toThrow("temporary");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([
      [1_000, undefined],
      [3_000, undefined],
    ]);
  });

  it("returns immediately and stops when an error is not retryable", async () => {
    const expected = new Error("permanent");
    await expect(
      retry(
        async () => "ok",
        () => true,
      ),
    ).resolves.toBe("ok");
    const operation = vi.fn(async () => {
      throw expected;
    });
    const shouldRetry = vi.fn(() => false);
    await expect(retry(operation, shouldRetry)).rejects.toBe(expected);
    expect(operation).toHaveBeenCalledOnce();
    expect(shouldRetry).toHaveBeenCalledWith(expected, 1);
  });

  it("validates attempt counts", () => {
    for (const attempts of [0, -1, 1.5, Number.NaN]) {
      expect(() => new RetryStrategy({ attempts })).toThrow(
        new RangeError("attempts must be a positive integer"),
      );
    }
  });

  it("forwards the signal and uses the later-attempt backoff base", async () => {
    const sleep = vi.fn(async () => undefined);
    const clock: Clock = { now: () => 0, sleep };
    const signal = new AbortController().signal;
    const strategy = new RetryStrategy({
      attempts: 4,
      clock,
      random: () => 0.25,
    });
    await strategy.waitBefore(1, signal);
    await strategy.waitBefore(2, signal);
    await strategy.waitBefore(4, signal);
    expect(sleep.mock.calls).toEqual([
      [500, signal],
      [2_500, signal],
    ]);
  });
});
