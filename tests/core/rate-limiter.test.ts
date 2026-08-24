import { describe, expect, it, vi } from "vitest";

import type { Clock } from "../../src/core/clock.js";
import { RateLimiter } from "../../src/core/rate-limiter.js";

function clock(now: number): Clock {
  return { now: () => now, sleep: vi.fn(async () => undefined) };
}

describe("RateLimiter", () => {
  it("uses the prawcore rolling-window calculation", () => {
    const limiter = new RateLimiter({
      windowSizeMs: 180_000,
      clock: clock(100_000),
    });
    limiter.update({
      "x-ratelimit-remaining": "60.0",
      "x-ratelimit-reset": "72",
      "x-ratelimit-used": "100",
    });
    expect(limiter.state()).toEqual({
      remaining: 60,
      used: 100,
      nextRequestAt: 104_500,
    });
  });

  it("waits the full reset with a one-second minimum when exhausted", async () => {
    const fakeClock = clock(37_000);
    const limiter = new RateLimiter({ clock: fakeClock });
    limiter.update({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "0",
      "x-ratelimit-used": "100",
    });
    await limiter.delay();
    expect(fakeClock.sleep).toHaveBeenCalledWith(1_000, undefined);
  });

  it("accounts conservatively for responses without rate headers", () => {
    const limiter = new RateLimiter({ clock: clock(0) });
    limiter.remaining = 10;
    limiter.used = 99;
    limiter.update({});
    expect(limiter.state()).toMatchObject({ remaining: 9, used: 100 });
  });

  it("matches headers case-insensitively and ignores incomplete or malformed values", () => {
    const limiter = new RateLimiter({ clock: clock(100) });
    limiter.update({ "X-RateLimit-Remaining": "5", "X-RateLimit-Used": "2" });
    expect(limiter.state()).toEqual({
      remaining: undefined,
      used: undefined,
      nextRequestAt: undefined,
    });
    limiter.update({
      "x-ratelimit-remaining": "not-a-number",
      "x-ratelimit-reset": "10",
      "x-ratelimit-used": "2",
    });
    expect(limiter.state()).toEqual({
      remaining: undefined,
      used: undefined,
      nextRequestAt: undefined,
    });
  });

  it("does not sleep when no delay is scheduled or the deadline has passed", async () => {
    const fakeClock = clock(1_000);
    const limiter = new RateLimiter({ clock: fakeClock });
    await limiter.delay();
    limiter.nextRequestAt = 999;
    await limiter.delay(new AbortController().signal);
    expect(fakeClock.sleep).not.toHaveBeenCalled();
  });

  it("decrements only when both prior counters are known", () => {
    const limiter = new RateLimiter({ clock: clock(0) });
    limiter.remaining = 3;
    limiter.update({});
    expect(limiter.remaining).toBe(3);
  });
});
