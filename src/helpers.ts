import { Listing, type ListingOptions } from "./listing.js";
import { Objector } from "./objector.js";
import { SubredditFlair } from "./domains/flair.js";
import { SubredditEmoji } from "./domains/emoji.js";
import { SubredditCollections } from "./domains/collections.js";
import { RedditorModNotes, SubredditModNotes } from "./domains/mod-notes.js";
import { LegacyModmailDomain, ModmailDomain } from "./domains/modmail.js";
import {
  SubredditModeration,
  SubredditQuarantine,
} from "./domains/moderation.js";
import { SubredditRemovalReasons } from "./domains/removal-reasons.js";
import {
  type SubredditRelationships,
  ContributorRelationship,
  ModeratorRelationship,
  SubredditRelationship,
  createSubredditRelationships,
} from "./domains/relationships.js";
import { SubredditRules } from "./domains/rules.js";
import { SubredditStylesheet } from "./domains/stylesheet.js";
import { SubredditWidgets } from "./domains/widgets.js";
import { SubredditWiki } from "./domains/wiki.js";
import type { ModmailClient } from "./models/modmail.js";
import type { ModerationClientLike } from "./models/moderation.js";
import {
  Comment,
  Redditor,
  Submission,
  Subreddit,
  type RedditEntity,
} from "./models/entities.js";
import type { QueryValue, RedditClientLike } from "./models/base.js";
import {
  listingStream,
  type ContentStream,
  type StreamFetchOptions,
  type StreamOptions,
} from "./stream.js";

const TIME_FILTERS = new Set(["all", "day", "hour", "month", "week", "year"]);

export type TimeFilter = "all" | "day" | "hour" | "month" | "week" | "year";

export interface SortedListingOptions extends ListingOptions {
  readonly timeFilter?: TimeFilter;
}

export type SearchSort = "comments" | "hot" | "new" | "relevance" | "top";
export type SearchSyntax = "cloudsearch" | "lucene" | "plain";

export interface SearchOptions extends ListingOptions {
  readonly sort?: SearchSort;
  readonly syntax?: SearchSyntax;
  readonly timeFilter?: TimeFilter;
}

export type PostRequirements = Readonly<Record<string, unknown>>;
export type TrafficStats = Readonly<
  Record<"day" | "hour" | "month", readonly (readonly number[])[]>
>;

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

  controversial(options: SortedListingOptions = {}): Listing<T> {
    return new Listing<T>(
      this.client,
      `${this.path}/controversial`,
      sortedOptions(options),
    );
  }
}

export class Front extends ListingHelper {
  constructor(client: RedditClientLike) {
    super(client, "");
  }

  best(options: ListingOptions = {}): Listing<Submission> {
    return new Listing<Submission>(this.client, "/best", options);
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
  readonly banned: SubredditRelationship;
  readonly collections: SubredditCollections;
  readonly contributor: ContributorRelationship;
  readonly emoji: SubredditEmoji;
  readonly flair: SubredditFlair;
  readonly legacyModmail: LegacyModmailDomain;
  readonly listings: ListingHelper;
  readonly moderation: SubredditModeration;
  readonly moderator: ModeratorRelationship;
  readonly modmail: ModmailDomain;
  readonly modNotes: SubredditModNotes;
  readonly muted: SubredditRelationship;
  readonly quarantine: SubredditQuarantine;
  readonly relationships: SubredditRelationships;
  readonly removalReasons: SubredditRemovalReasons;
  readonly rules: SubredditRules;
  readonly stream: SubredditStream;
  readonly stylesheet: SubredditStylesheet;
  readonly widgets: SubredditWidgets;
  readonly wiki: SubredditWiki;
  readonly wikibanned: SubredditRelationship;
  readonly wikicontributor: SubredditRelationship;

  constructor(client: RedditClientLike, name: string) {
    super(client, name);
    const moderationClient = client as ModerationClientLike;
    this.moderation = new SubredditModeration(moderationClient, this);
    this.quarantine = new SubredditQuarantine(moderationClient, this);
    this.relationships = createSubredditRelationships(moderationClient, this);
    this.banned = this.relationships.banned;
    this.contributor = this.relationships.contributor;
    this.moderator = this.relationships.moderator;
    this.muted = this.relationships.muted;
    this.wikibanned = this.relationships.wikibanned;
    this.wikicontributor = this.relationships.wikicontributor;
    this.flair = new SubredditFlair(moderationClient, this);
    this.modNotes = this.moderation.notes;
    this.rules = new SubredditRules(moderationClient, this);
    this.removalReasons = new SubredditRemovalReasons(moderationClient, this);
    this.wiki = new SubredditWiki(moderationClient, this);
    this.emoji = new SubredditEmoji(moderationClient, this);
    this.stylesheet = new SubredditStylesheet(moderationClient, this);
    this.widgets = new SubredditWidgets(moderationClient, this);
    this.collections = new SubredditCollections(client, this);
    this.modmail = new ModmailDomain(client as ModmailClient, this);
    this.legacyModmail = new LegacyModmailDomain(client as ModmailClient, this);
    this.listings = new ListingHelper(
      client,
      `/r/${pathSegment(name, "subreddit")}`,
    );
    this.stream = new SubredditStream(this);
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

  controversial(options: SortedListingOptions = {}): Listing<Submission> {
    return this.listings.controversial(options);
  }

  comments(options: ListingOptions = {}): Listing<Comment> {
    return new Listing<Comment>(
      this.client,
      `/r/${pathSegment(this.toString(), "subreddit")}/comments`,
      options,
    );
  }

  search(query: string, options: SearchOptions = {}): Listing<Submission> {
    const normalized = query.trim();
    if (normalized.length === 0) throw new TypeError("query cannot be empty");
    const {
      sort = "relevance",
      syntax = "lucene",
      timeFilter = "all",
      ...listingOptions
    } = options;
    if (!["comments", "hot", "new", "relevance", "top"].includes(sort))
      throw new RangeError(`Invalid search sort: ${sort}`);
    if (!["cloudsearch", "lucene", "plain"].includes(syntax))
      throw new RangeError(`Invalid search syntax: ${syntax}`);
    const { params, ...rest } = sortedOptions({
      ...listingOptions,
      timeFilter,
    });
    return new Listing<Submission>(
      this.client,
      `/r/${pathSegment(this.toString(), "subreddit")}/search`,
      {
        ...rest,
        params: {
          ...params,
          q: normalized,
          restrict_sr: this.toString().toLowerCase() !== "all",
          sort,
          syntax,
        },
      },
    );
  }

  async sticky(
    options: { readonly number?: 1 | 2; readonly signal?: AbortSignal } = {},
  ): Promise<Submission> {
    const number = validStickyNumber(options.number ?? 1);
    options.signal?.throwIfAborted();
    const response = await this.client.request({
      method: "GET",
      path: `/r/${pathSegment(this.toString(), "subreddit")}/about/sticky/`,
      params: { num: number },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const submission = findObjectified<Submission>(
      new Objector(this.client).objectify(response),
      Submission,
    );
    if (submission === undefined)
      throw new TypeError("Reddit sticky response contained no Submission");
    return submission;
  }

  async postRequirements(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PostRequirements> {
    return this.recordRequest(
      `/api/v1/${pathSegment(this.toString(), "subreddit")}/post_requirements`,
      "post requirements",
      options.signal,
    );
  }

  async traffic(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TrafficStats> {
    const value = await this.recordRequest(
      `/r/${pathSegment(this.toString(), "subreddit")}/about/traffic/`,
      "traffic",
      options.signal,
    );
    for (const key of ["day", "hour", "month"] as const) {
      if (!Array.isArray(value[key]))
        throw new TypeError(`Reddit traffic response has no ${key} array`);
    }
    return value as TrafficStats;
  }

  private async recordRequest(
    path: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    signal?.throwIfAborted();
    const response = await this.client.request({
      method: "GET",
      path,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      typeof response !== "object" ||
      response === null ||
      Array.isArray(response)
    )
      throw new TypeError(`Reddit returned invalid ${name} data`);
    return response as Readonly<Record<string, unknown>>;
  }
}

export class SubredditStream {
  readonly subreddit: ListingSubreddit;

  constructor(subreddit: ListingSubreddit) {
    this.subreddit = subreddit;
  }

  comments(options: StreamOptions<Comment> = {}): ContentStream<Comment> {
    return listingStream(
      (fetchOptions) =>
        this.subreddit.comments(streamListingOptions(fetchOptions)),
      options,
    );
  }

  submissions(
    options: StreamOptions<Submission> = {},
  ): ContentStream<Submission> {
    return listingStream(
      (fetchOptions) => this.subreddit.new(streamListingOptions(fetchOptions)),
      options,
    );
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

  override controversial(options: SortedListingOptions = {}): Listing<T> {
    const { params, ...rest } = sortedOptions(options);
    return new Listing<T>(this.client, this.path, {
      ...rest,
      params: { ...params, sort: "controversial" },
    });
  }
}

export class ListingRedditor extends Redditor {
  readonly comments: RedditorContent<Comment>;
  readonly overview: RedditorContent<RedditEntity>;
  readonly submissions: RedditorContent<Submission>;
  readonly stream: RedditorStream;
  readonly notes: RedditorModNotes;

  constructor(client: RedditClientLike, name: string) {
    super(client, name);
    const path = `/user/${pathSegment(name, "redditor")}`;
    this.overview = new RedditorContent(client, `${path}/overview`);
    this.comments = new RedditorContent(client, `${path}/comments`);
    this.submissions = new RedditorContent(client, `${path}/submitted`);
    this.stream = new RedditorStream(this);
    this.notes = new RedditorModNotes(client, this);
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

  controversial(options: SortedListingOptions = {}): Listing<RedditEntity> {
    return this.overview.controversial(options);
  }

  saved(options: ListingOptions = {}): Listing<RedditEntity> {
    return this.history("saved", options);
  }

  hidden(options: ListingOptions = {}): Listing<RedditEntity> {
    return this.history("hidden", options);
  }

  upvoted(options: ListingOptions = {}): Listing<RedditEntity> {
    return this.history("upvoted", options);
  }

  downvoted(options: ListingOptions = {}): Listing<RedditEntity> {
    return this.history("downvoted", options);
  }

  private history(
    name: string,
    options: ListingOptions,
  ): Listing<RedditEntity> {
    return new Listing<RedditEntity>(
      this.client,
      `/user/${pathSegment(this.toString(), "redditor")}/${name}`,
      options,
    );
  }
}

export class RedditorStream {
  readonly redditor: ListingRedditor;

  constructor(redditor: ListingRedditor) {
    this.redditor = redditor;
  }

  comments(options: StreamOptions<Comment> = {}): ContentStream<Comment> {
    return listingStream(
      (fetchOptions) =>
        this.redditor.comments.new(streamListingOptions(fetchOptions)),
      options,
    );
  }

  submissions(
    options: StreamOptions<Submission> = {},
  ): ContentStream<Submission> {
    return listingStream(
      (fetchOptions) =>
        this.redditor.submissions.new(streamListingOptions(fetchOptions)),
      options,
    );
  }
}

function streamListingOptions(options: StreamFetchOptions): ListingOptions {
  return {
    limit: options.limit,
    params: options.before === undefined ? {} : { before: options.before },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function validStickyNumber(value: unknown): 1 | 2 {
  if (value !== 1 && value !== 2)
    throw new RangeError("sticky number must be 1 or 2");
  return value;
}

function findObjectified<T>(
  value: unknown,
  constructor: abstract new (...args: never[]) => T,
): T | undefined {
  if (value instanceof constructor) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectified(item, constructor);
      if (found !== undefined) return found;
    }
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      const found = findObjectified(item, constructor);
      if (found !== undefined) return found;
    }
  }
  return undefined;
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
