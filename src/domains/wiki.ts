import { type Listing, type ListingOptions } from "../listing.js";
import { SubredditRelationship } from "./relationships.js";
import { isRawData } from "../models/base.js";
import {
  WikiPage,
  WikiRevision,
  wikiPageName,
  wikiRevisions,
  type WikiClientLike,
  type WikiEditOptions,
} from "../models/wiki.js";
import {
  assertModeratorAccess,
  subredditName,
  subredditPath,
  type SubredditReference,
} from "../models/moderation.js";

export interface CreateWikiPageOptions extends WikiEditOptions {
  readonly content: string;
  readonly name: string;
}

export class SubredditWiki implements AsyncIterable<WikiPage> {
  readonly client: WikiClientLike;
  readonly subreddit: SubredditReference;
  readonly banned: SubredditRelationship;
  readonly contributor: SubredditRelationship;

  constructor(client: WikiClientLike, subreddit: SubredditReference) {
    this.client = client;
    this.subreddit = subreddit;
    subredditName(subreddit);
    this.banned = new SubredditRelationship(client, subreddit, "wikibanned");
    this.contributor = new SubredditRelationship(
      client,
      subreddit,
      "wikicontributor",
    );
  }

  get(name: string): WikiPage {
    return new WikiPage(this.client, this.subreddit, wikiPageName(name));
  }

  page(name: string): WikiPage {
    return this.get(name);
  }

  async list(signal?: AbortSignal): Promise<WikiPage[]> {
    signal?.throwIfAborted();
    const response = await this.client.request({
      method: "GET",
      path: `/r/${subredditPath(this.subreddit)}/wiki/pages/`,
      ...(signal === undefined ? {} : { signal }),
    });
    let pages: unknown = response;
    if (isRawData(pages)) pages = pages["data"];
    if (
      !Array.isArray(pages) ||
      !pages.every((page) => typeof page === "string")
    ) {
      throw new TypeError("Reddit returned invalid wiki pages data");
    }
    return pages.map((name) => this.get(name));
  }

  async create(
    options: CreateWikiPageOptions,
    signal?: AbortSignal,
  ): Promise<WikiPage> {
    assertModeratorAccess(this.client, "wiki.create()");
    const page = new WikiPage(
      this.client,
      this.subreddit,
      wikiPageName(options.name, true),
    );
    await page.edit(
      options.content,
      {
        ...(options.previous === undefined
          ? {}
          : { previous: options.previous }),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
      signal,
    );
    return page;
  }

  revisions(options: ListingOptions = {}): Listing<WikiRevision> {
    return wikiRevisions(
      this.client,
      this.subreddit,
      `/r/${subredditPath(this.subreddit)}/wiki/revisions/`,
      options,
    );
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WikiPage> {
    yield* await this.list();
  }
}
