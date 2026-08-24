export interface StreamFetchOptions {
  readonly before?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export type StreamFetcher<T> = (
  options: StreamFetchOptions,
) => AsyncIterable<T> | Iterable<T> | Promise<AsyncIterable<T> | Iterable<T>>;
export type Sleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export interface StreamOptions<T> {
  readonly attribute?: keyof T | string;
  readonly continueAfterId?: string;
  readonly excludeBefore?: boolean;
  readonly onError?: (error: unknown) => Promise<void> | void;
  readonly pauseAfter?: number | null;
  readonly random?: () => number;
  readonly seenCapacity?: number;
  readonly signal?: AbortSignal;
  readonly skipExisting?: boolean;
  readonly sleep?: Sleep;
}

export type ContentStream<T> = AsyncGenerator<T | null>;

/** Bind PRAW-style polling behavior to a newest-first listing function. */
export function listingStream<T>(
  fetch: StreamFetcher<T>,
  options: StreamOptions<T> = {},
): ContentStream<T> {
  return streamGenerator(fetch, options);
}

class BoundedSeen {
  readonly capacity: number;
  #items = new Map<string, true>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0)
      throw new RangeError("seenCapacity must be a positive integer");
    this.capacity = capacity;
  }

  has(value: string): boolean {
    if (!this.#items.delete(value)) return false;
    this.#items.set(value, true);
    return true;
  }

  add(value: string): void {
    this.#items.delete(value);
    this.#items.set(value, true);
    if (this.#items.size > this.capacity) {
      const oldest = this.#items.keys().next().value;
      if (oldest !== undefined) this.#items.delete(oldest);
    }
  }
}

export const defaultSleep: Sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError"),
      );
    }
    signal?.addEventListener("abort", abort, { once: true });
  });

async function collect<T>(
  source: AsyncIterable<T> | Iterable<T>,
): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

function itemId<T>(item: T, attribute: keyof T | string): string {
  if (typeof item !== "object" || item === null)
    throw new TypeError("Stream items must be objects");
  const value = (item as Record<PropertyKey, unknown>)[attribute];
  if (typeof value !== "string")
    throw new TypeError(
      `Stream item attribute ${String(attribute)} must be a string`,
    );
  return value;
}

/** Poll a newest-first listing and yield unseen items oldest first. */
export async function* streamGenerator<T>(
  fetch: StreamFetcher<T>,
  options: StreamOptions<T> = {},
): AsyncGenerator<T | null> {
  const attribute = options.attribute ?? "fullname";
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const seen = new BoundedSeen(options.seenCapacity ?? 301);
  let before = options.continueAfterId;
  let baseDelaySeconds = 1;
  let noBeforeCounter = 0;
  let emptyResponses = 0;
  let skipExisting = options.skipExisting ?? false;

  for (;;) {
    options.signal?.throwIfAborted();
    let limit = 100;
    if (before === undefined) {
      limit -= noBeforeCounter;
      noBeforeCounter = (noBeforeCounter + 1) % 30;
    }

    let items: T[];
    try {
      const source = await fetch({
        limit,
        ...(!options.excludeBefore && before !== undefined ? { before } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      items = await collect(source);
    } catch (error) {
      if (options.signal?.aborted === true) throw options.signal.reason;
      if (options.onError === undefined) throw error;
      await options.onError(error);
      const jittered =
        baseDelaySeconds + (random() - 0.5) * (baseDelaySeconds / 16);
      baseDelaySeconds = Math.min(baseDelaySeconds * 2, 16);
      await sleep(jittered * 1000, options.signal);
      continue;
    }

    let found = false;
    let newest: string | undefined;
    for (const item of items.toReversed()) {
      const id = itemId(item, attribute);
      if (seen.has(id)) continue;
      found = true;
      seen.add(id);
      newest = id;
      if (!skipExisting) yield item;
    }
    before = newest;
    skipExisting = false;

    if (
      options.pauseAfter !== undefined &&
      options.pauseAfter !== null &&
      options.pauseAfter < 0
    ) {
      yield null;
    } else if (found) {
      baseDelaySeconds = 1;
      emptyResponses = 0;
    } else {
      emptyResponses += 1;
      if (
        options.pauseAfter !== undefined &&
        options.pauseAfter !== null &&
        emptyResponses > options.pauseAfter
      ) {
        baseDelaySeconds = 1;
        emptyResponses = 0;
        yield null;
      } else {
        const jittered =
          baseDelaySeconds + (random() - 0.5) * (baseDelaySeconds / 16);
        baseDelaySeconds = Math.min(baseDelaySeconds * 2, 16);
        await sleep(jittered * 1000, options.signal);
      }
    }
  }
}

export { streamGenerator as pollingStream };
