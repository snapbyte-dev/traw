import { describe, expect, it, vi } from "vitest";

import { systemClock } from "../../src/core/clock.js";

describe("systemClock", () => {
  it("supports cancellation while sleeping", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const sleeping = systemClock.sleep(1_000, controller.signal);
    controller.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
    vi.useRealTimers();
  });

  it("rejects an already aborted sleep with a standard abort error", async () => {
    const controller = new AbortController();
    controller.abort("non-error reason");
    await expect(
      systemClock.sleep(10, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves negative sleeps and removes abort handling", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const sleeping = systemClock.sleep(-10, controller.signal);
    await vi.runAllTimersAsync();
    await expect(sleeping).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(systemClock.now()).toBeTypeOf("number");
    vi.useRealTimers();
  });
});
