import { systemClock, type Clock } from "./clock.js";

export interface RetryOptions {
  readonly attempts?: number;
  readonly clock?: Clock;
  readonly random?: () => number;
}

export class RetryStrategy {
  readonly attempts: number;
  readonly #clock: Clock;
  readonly #random: () => number;

  constructor(options: RetryOptions = {}) {
    this.attempts = options.attempts ?? 3;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    if (!Number.isInteger(this.attempts) || this.attempts < 1) {
      throw new RangeError("attempts must be a positive integer");
    }
  }

  async waitBefore(attempt: number, signal?: AbortSignal): Promise<void> {
    if (attempt <= 1) return;
    const base = attempt === 2 ? 0 : 2_000;
    await this.#clock.sleep(base + 2_000 * this.#random(), signal);
  }
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  shouldRetry: (error: unknown, attempt: number) => boolean,
  options: RetryOptions & { readonly signal?: AbortSignal } = {},
): Promise<T> {
  const strategy = new RetryStrategy(options);
  for (let attempt = 1; attempt <= strategy.attempts; attempt += 1) {
    await strategy.waitBefore(attempt, options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === strategy.attempts || !shouldRetry(error, attempt))
        throw error;
    }
  }
  throw new Error("retry loop exhausted");
}
