import { Objector } from "../objector.js";
import { isRawData, type RawData } from "../models/base.js";
import {
  Collection,
  assertCollectionAuthorized,
  parseCollectionData,
  requiredCollectionString,
  validateCollectionLayout,
  type CollectionLayout,
  type CollectionsClient,
} from "../models/collection.js";
import { Subreddit } from "../models/entities.js";

export interface CreateCollectionOptions {
  readonly description: string;
  readonly layout?: Exclude<CollectionLayout, "">;
  readonly title: string;
}

function collectionIdFromPermalink(
  value: string,
  subreddit: Subreddit,
): string {
  const permalink = requiredCollectionString(value, "collection permalink");
  let path = permalink;
  try {
    const url = new URL(permalink);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError("collection permalink must use HTTP or HTTPS");
    }
    path = url.pathname;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("must use"))
      throw error;
  }
  const match = /^\/r\/([^/]+)\/collection\/([^/?#]+)\/?$/i.exec(path);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new TypeError("collection permalink is invalid");
  }
  if (
    decodeURIComponent(match[1]).toLowerCase() !==
    subreddit.toString().toLowerCase()
  ) {
    throw new TypeError(
      "collection permalink belongs to a different subreddit",
    );
  }
  return requiredCollectionString(
    decodeURIComponent(match[2]),
    "collection ID",
  );
}

function collectionArray(value: unknown): RawData[] {
  let data = value;
  if (isRawData(data) && Array.isArray(data["data"])) data = data["data"];
  if (!Array.isArray(data) || !data.every(isRawData)) {
    throw new TypeError("Reddit returned invalid collections data");
  }
  return data;
}

export class SubredditCollections {
  readonly client: CollectionsClient;
  readonly subreddit: Subreddit;

  constructor(client: CollectionsClient, subreddit: Subreddit) {
    this.client = client;
    this.subreddit = subreddit;
    requiredCollectionString(subreddit.toString(), "subreddit");
  }

  get(collectionId: string): Collection {
    return new Collection(this.client, this.subreddit, collectionId);
  }

  getByPermalink(permalink: string): Collection {
    return this.get(collectionIdFromPermalink(permalink, this.subreddit));
  }

  async list(signal?: AbortSignal): Promise<Collection[]> {
    signal?.throwIfAborted();
    if (this.subreddit.fullname === undefined) {
      await this.subreddit.load(signal === undefined ? {} : { signal });
    }
    const fullname = this.subreddit.fullname;
    if (fullname === undefined) {
      throw new TypeError("Subreddit has no fullname for collection requests");
    }
    const response = await this.client.request({
      method: "GET",
      path: "/api/v1/collections/subreddit_collections",
      params: { sr_fullname: fullname },
      ...(signal === undefined ? {} : { signal }),
    });
    return collectionArray(response).map(
      (data) => new Collection(this.client, this.subreddit, data),
    );
  }

  async create(
    options: CreateCollectionOptions,
    signal?: AbortSignal,
  ): Promise<Collection> {
    assertCollectionAuthorized(this.client, "collections.create()");
    signal?.throwIfAborted();
    const title = requiredCollectionString(options.title, "title");
    if (title.length > 300)
      throw new RangeError("title must be 300 characters or less");
    if (options.description.length > 500) {
      throw new RangeError("description must be 500 characters or less");
    }
    if (options.layout !== undefined) validateCollectionLayout(options.layout);
    if (this.subreddit.fullname === undefined) {
      await this.subreddit.load(signal === undefined ? {} : { signal });
    }
    const fullname = this.subreddit.fullname;
    if (fullname === undefined) {
      throw new TypeError("Subreddit has no fullname for collection requests");
    }
    const response = await this.client.request({
      method: "POST",
      path: "/api/v1/collections/create_collection",
      data: {
        description: options.description,
        sr_fullname: fullname,
        title,
        ...(options.layout === undefined
          ? {}
          : { display_layout: options.layout }),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    new Objector(this.client).objectify(response);
    return new Collection(
      this.client,
      this.subreddit,
      parseCollectionData(this.client, response),
    );
  }
}

export function createSubredditCollections(
  client: CollectionsClient,
  subreddit: Subreddit,
): SubredditCollections {
  return new SubredditCollections(client, subreddit);
}

export type { CollectionsClient } from "../models/collection.js";
