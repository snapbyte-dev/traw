import { systemClock, type Clock } from "./clock.js";

export interface RateLimitState {
  readonly remaining: number | undefined;
  readonly used: number | undefined;
  readonly nextRequestAt: number | undefined;
}

export class RateLimiter {
  remaining: number | undefined;
  used: number | undefined;
  nextRequestAt: number | undefined;

  readonly #clock: Clock;
  readonly #windowSizeMs: number;

  constructor(options: { windowSizeMs?: number; clock?: Clock } = {}) {
    this.#windowSizeMs = options.windowSizeMs ?? 600_000;
    this.#clock = options.clock ?? systemClock;
  }

  async delay(signal?: AbortSignal): Promise<void> {
    if (this.nextRequestAt === undefined) return;
    const delay = this.nextRequestAt - this.#clock.now();
    if (delay > 0) await this.#clock.sleep(delay, signal);
  }

  update(headers: Readonly<Record<string, string>>): void {
    const getHeader = (name: string): string | undefined => {
      const target = name.toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === target) return value;
      }
      return undefined;
    };
    const remainingHeader = getHeader("x-ratelimit-remaining");
    if (remainingHeader === undefined) {
      if (this.remaining !== undefined && this.used !== undefined) {
        this.remaining -= 1;
        this.used += 1;
      }
      return;
    }

    const usedHeader = getHeader("x-ratelimit-used");
    const resetHeader = getHeader("x-ratelimit-reset");
    if (usedHeader === undefined || resetHeader === undefined) return;

    const remaining = Number.parseFloat(remainingHeader);
    const used = Number.parseFloat(usedHeader);
    const reset = Number.parseFloat(resetHeader);
    if (![remaining, used, reset].every(Number.isFinite)) return;
    this.remaining = Math.trunc(remaining);
    this.used = Math.trunc(used);
    const resetMs = Math.trunc(reset) * 1_000;
    const now = this.#clock.now();

    if (this.remaining <= 0) {
      this.nextRequestAt = now + Math.max(1_000, resetMs);
      return;
    }

    const total = this.remaining + this.used;
    const elapsedEstimate =
      this.#windowSizeMs - (this.#windowSizeMs / total) * this.used;
    this.nextRequestAt =
      now + Math.min(resetMs, Math.max(resetMs - elapsedEstimate, 0), 10_000);
  }

  state(): RateLimitState {
    return {
      remaining: this.remaining,
      used: this.used,
      nextRequestAt: this.nextRequestAt,
    };
  }
}
