import { ReadOnlyError } from "../exceptions.js";
import { ListingSubreddit } from "../helpers.js";
import { Listing, type ListingOptions } from "../listing.js";
import type { DataValue, RedditClientLike } from "../models/base.js";
import { Subreddit } from "../models/entities.js";
import {
  subredditSettingsPayload,
  validateSubredditSettings,
  type SubredditContentOptions,
  type SubredditSettingsOptions,
} from "./moderation.js";

export interface SubredditsClient extends RedditClientLike {
  readonly readOnly?: boolean;
}

export type CreateSubredditOptions = Omit<
  SubredditSettingsOptions,
  "contentOptions"
> & {
  readonly linkType?: SubredditContentOptions;
};

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return normalized;
}

export class SubredditsDomain {
  readonly #client: SubredditsClient;

  constructor(client: SubredditsClient) {
    this.#client = client;
  }

  default(options: ListingOptions = {}): Listing<Subreddit> {
    return new Listing(this.#client, "/subreddits/default/", options);
  }

  new(options: ListingOptions = {}): Listing<Subreddit> {
    return new Listing(this.#client, "/subreddits/new/", options);
  }

  popular(options: ListingOptions = {}): Listing<Subreddit> {
    return new Listing(this.#client, "/subreddits/popular/", options);
  }

  search(query: string, options: ListingOptions = {}): Listing<Subreddit> {
    return new Listing(this.#client, "/subreddits/search/", {
      ...options,
      params: { ...options.params, q: nonEmpty(query, "query") },
    });
  }

  async create(
    name: string,
    options: CreateSubredditOptions = {},
    signal?: AbortSignal,
  ): Promise<ListingSubreddit> {
    if (this.#client.readOnly === true) {
      throw new ReadOnlyError(
        "subreddits.create() does not work in read-only mode",
      );
    }
    signal?.throwIfAborted();
    const normalizedName = nonEmpty(name, "name");
    const suppliedTitle = options.title?.trim();
    const { linkType = "any", ...otherSettings } = options;
    const settings: SubredditSettingsOptions = {
      contentOptions: linkType,
      subredditType: "public",
      wikimode: "disabled",
      ...otherSettings,
      title:
        suppliedTitle === undefined || suppliedTitle.length === 0
          ? normalizedName
          : suppliedTitle,
    };
    validateSubredditSettings(settings);
    const data: Record<string, DataValue> = { name: normalizedName };
    for (const [key, value] of Object.entries(
      subredditSettingsPayload(settings, true),
    )) {
      if (value !== null) data[key] = value;
    }
    await this.#client.request({
      method: "POST",
      path: "/api/site_admin/",
      data,
      ...(signal === undefined ? {} : { signal }),
    });
    return new ListingSubreddit(this.#client, normalizedName);
  }
}
