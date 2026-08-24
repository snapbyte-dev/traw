import { Listing, type ListingOptions } from "./listing.js";
import { Objector } from "./objector.js";
import {
  Redditor,
  Submission,
  Subreddit,
  type RedditEntity,
} from "./models/entities.js";
import type { QueryValue, RedditClientLike } from "./models/base.js";

const TIME_FILTERS = new Set(["all", "day", "hour", "month", "week", "year"]);

export type TimeFilter = "all" | "day" | "hour" | "month" | "week" | "year";

export interface SortedListingOptions extends ListingOptions {
  readonly timeFilter?: TimeFilter;
}

function pathSegment(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return encodeURIComponent(normalized);
}

function sortedOptions(options: SortedListingOptions): ListingOptions {
  const { timeFilter = "all", ...listingOptions } = options;
  if (!TIME_FILTERS.has(timeFilter))
    throw new RangeError(`Invalid time filter: ${timeFilter}`);
  return {
    ...listingOptions,
    params: { ...listingOptions.params, t: timeFilter },
  };
}

/** Common hot/new/top/rising listing surface used by front pages and containers. */
export class ListingHelper<T = Submission> {
  readonly client: RedditClientLike;
  readonly path: string;

  constructor(client: RedditClientLike, path: string) {
    this.client = client;
    this.path = path.replace(/\/$/, "");
  }

  hot(options: ListingOptions = {}): Listing<T> {
    return new Listing<T>(this.client, `${this.path}/hot`, options);
  }

  new(options: ListingOptions = {}): Listing<T> {
    return new Listing<T>(this.client, `${this.path}/new`, options);
  }

  rising(options: ListingOptions = {}): Listing<T> {
    return new Listing<T>(this.client, `${this.path}/rising`, options);
  }

  top(options: SortedListingOptions = {}): Listing<T> {
    return new Listing<T>(
      this.client,
      `${this.path}/top`,
      sortedOptions(options),
    );
  }
}

export class Front extends ListingHelper {
  constructor(client: RedditClientLike) {
    super(client, "");
  }
}

export class Domain extends ListingHelper {
  readonly name: string;

  constructor(client: RedditClientLike, name: string) {
    const normalized = name.trim();
    super(client, `/domain/${pathSegment(normalized, "domain")}`);
    this.name = normalized;
  }
}

export class ListingSubreddit extends Subreddit {
  readonly listings: ListingHelper;

  constructor(client: RedditClientLike, name: string) {
    super(client, name);
    this.listings = new ListingHelper(
      client,
      `/r/${pathSegment(name, "subreddit")}`,
    );
  }

  hot(options: ListingOptions = {}): Listing<Submission> {
    return this.listings.hot(options);
  }

  new(options: ListingOptions = {}): Listing<Submission> {
    return this.listings.new(options);
  }

  rising(options: ListingOptions = {}): Listing<Submission> {
    return this.listings.rising(options);
  }

  top(options: SortedListingOptions = {}): Listing<Submission> {
    return this.listings.top(options);
  }
}

export class RedditorContent<T> extends ListingHelper<T> {
  override hot(options: ListingOptions = {}): Listing<T> {
    return new Listing<T>(this.client, this.path, {
      ...options,
      params: { ...options.params, sort: "hot" },
    });
  }

  override new(options: ListingOptions = {}): Listing<T> {
    return new Listing<T>(this.client, this.path, {
      ...options,
      params: { ...options.params, sort: "new" },
    });
  }

  override rising(options: ListingOptions = {}): Listing<T> {
    return new Listing<T>(this.client, this.path, {
      ...options,
      params: { ...options.params, sort: "rising" },
    });
  }

  override top(options: SortedListingOptions = {}): Listing<T> {
    const { params, ...rest } = sortedOptions(options);
    return new Listing<T>(this.client, this.path, {
      ...rest,
      params: { ...params, sort: "top" },
    });
  }
}

export class ListingRedditor extends Redditor {
  readonly comments: RedditorContent<RedditEntity>;
  readonly overview: RedditorContent<RedditEntity>;
  readonly submissions: RedditorContent<Submission>;

  constructor(client: RedditClientLike, name: string) {
    super(client, name);
    const path = `/user/${pathSegment(name, "redditor")}`;
    this.overview = new RedditorContent(client, `${path}/overview`);
    this.comments = new RedditorContent(client, `${path}/comments`);
    this.submissions = new RedditorContent(client, `${path}/submitted`);
  }

  hot(options: ListingOptions = {}): Listing<RedditEntity> {
    return this.overview.hot(options);
  }

  new(options: ListingOptions = {}): Listing<RedditEntity> {
    return this.overview.new(options);
  }

  top(options: SortedListingOptions = {}): Listing<RedditEntity> {
    return this.overview.top(options);
  }
}

export type SubredditHelper = (name: string) => ListingSubreddit;

export function createSubredditHelper(
  client: RedditClientLike,
): SubredditHelper {
  return (name: string) => new ListingSubreddit(client, name);
}

export interface InfoOptions {
  readonly fullnames?: Iterable<string>;
  readonly subreddits?: Iterable<string | Subreddit>;
  readonly url?: string;
  readonly signal?: AbortSignal;
}

/** A Listing-compatible async iterable that preserves PRAW's 100-item info batches. */
export class InfoListing extends Listing<RedditEntity> {
  readonly #batches: readonly string[];
  readonly #client: RedditClientLike;
  readonly #parameter: "id" | "sr_name" | "url";
  readonly #requestSignal: AbortSignal | undefined;
  #infoStarted = false;

  constructor(client: RedditClientLike, options: InfoOptions) {
    super(client, "/api/info", {
      limit: null,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    this.#client = client;
    this.#requestSignal = options.signal;

    const provided = [
      options.fullnames,
      options.subreddits,
      options.url,
    ].filter((value) => value !== undefined);
    if (provided.length !== 1) {
      throw new TypeError(
        "Exactly one of fullnames, subreddits, or url must be provided",
      );
    }
    if (options.url !== undefined) {
      this.#parameter = "url";
      this.#batches = [options.url];
      return;
    }

    const source = options.fullnames ?? options.subreddits;
    if (typeof source === "string") {
      throw new TypeError(
        "fullnames and subreddits must be non-string iterables",
      );
    }
    const values = Array.from(source ?? [], String);
    this.#parameter = options.fullnames === undefined ? "sr_name" : "id";
    const batches: string[] = [];
    for (let index = 0; index < values.length; index += 100) {
      batches.push(values.slice(index, index + 100).join(","));
    }
    this.#batches = batches;
  }

  override [Symbol.asyncIterator](): AsyncIterator<RedditEntity> {
    if (this.#infoStarted)
      throw new TypeError("A Listing can only be iterated once");
    this.#infoStarted = true;
    return this.iterateInfo();
  }

  private async *iterateInfo(): AsyncGenerator<RedditEntity> {
    const objector = new Objector(this.#client);
    for (const batch of this.#batches) {
      this.#requestSignal?.throwIfAborted();
      const params: Record<string, QueryValue> = { [this.#parameter]: batch };
      const response = await this.#client.request({
        method: "GET",
        params,
        path: "/api/info",
        ...(this.#requestSignal === undefined
          ? {}
          : { signal: this.#requestSignal }),
      });
      const objectified = objector.objectify(response);
      if (
        typeof objectified !== "object" ||
        objectified === null ||
        !("children" in objectified) ||
        !Array.isArray(objectified.children)
      ) {
        throw new TypeError("Reddit info response has no children array");
      }
      for (const child of objectified.children) yield child as RedditEntity;
    }
  }
}
