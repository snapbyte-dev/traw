import { performance } from "node:perf_hooks";

export interface Clock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (milliseconds, signal) => {
    if (signal?.aborted === true) {
      return Promise.reject(abortError(signal));
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(finish, Math.max(0, milliseconds));

      function finish(): void {
        signal?.removeEventListener("abort", abort);
        resolve();
      }

      function abort(): void {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (signal !== undefined) reject(abortError(signal));
      }

      signal?.addEventListener("abort", abort, { once: true });
    });
  },
};
