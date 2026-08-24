import { ReadOnlyError } from "../exceptions.js";
import { Objector } from "../objector.js";
import {
  RedditModel,
  isRawData,
  type LoadOptions,
  type RawData,
  type RedditClientLike,
  type RedditRequest,
} from "./base.js";
import { Submission, Subreddit } from "./entities.js";

export interface CollectionsClient extends RedditClientLike {
  readonly readOnly?: boolean;
}

export type CollectionLayout = "" | "GALLERY" | "TIMELINE";
export type SubmissionReference = string | Submission;

export function requiredCollectionString(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return normalized;
}

export function assertCollectionAuthorized(
  client: CollectionsClient,
  operation: string,
): void {
  if (client.readOnly === true) {
    throw new ReadOnlyError(`${operation} does not work in read-only mode`);
  }
}

export function validateCollectionLayout(layout: string): void {
  if (layout !== "" && layout !== "GALLERY" && layout !== "TIMELINE") {
    throw new TypeError("layout must be GALLERY, TIMELINE, or an empty string");
  }
}

function unwrapCollection(value: unknown): RawData {
  let data = value;
  if (isRawData(data) && isRawData(data["json"])) data = data["json"];
  if (isRawData(data) && isRawData(data["data"])) data = data["data"];
  if (!isRawData(data) || typeof data["collection_id"] !== "string") {
    throw new TypeError("Reddit returned invalid collection data");
  }
  return data;
}

function collectionSubmissions(
  client: CollectionsClient,
  value: unknown,
): Submission[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Reddit returned invalid collection submissions data");
  }
  const objector = new Objector(client);
  return value.map((item) => {
    const submission = objector.objectify(item);
    if (!(submission instanceof Submission)) {
      throw new TypeError("Reddit returned invalid collection submission data");
    }
    return submission;
  });
}

export function parseCollectionData(
  client: CollectionsClient,
  value: unknown,
): RawData {
  const data = unwrapCollection(value);
  const submissions = collectionSubmissions(client, data["sorted_links"]);
  return {
    ...data,
    ...(submissions === undefined ? {} : { sorted_links: submissions }),
  };
}

export function submissionFullname(value: SubmissionReference): string {
  if (value instanceof Submission) return value.fullname;
  const reference = requiredCollectionString(value, "submission");
  if (/^t3_[a-z0-9]+$/i.test(reference)) return reference;
  if (/^[a-z0-9]+$/i.test(reference)) return `t3_${reference}`;

  let path = reference;
  try {
    path = new URL(reference).pathname;
  } catch {
    // Relative Reddit permalinks are valid submission references.
  }
  const match = /\/comments\/([a-z0-9]+)(?:\/|$)/i.exec(path);
  if (match?.[1] !== undefined) return `t3_${match[1]}`;
  throw new TypeError(
    "submission must be an ID, fullname, or Reddit permalink",
  );
}

export class Collection extends RedditModel implements Iterable<Submission> {
  readonly kind = "collection";
  readonly identityField = "collection_id";
  readonly subreddit: Subreddit;
  declare description: unknown;
  declare display_layout: unknown;
  declare link_ids: unknown;
  declare permalink: unknown;
  declare sorted_links: unknown;
  declare title: unknown;

  constructor(
    client: CollectionsClient,
    subreddit: Subreddit,
    value: string | RawData,
  ) {
    super(
      client,
      "collection_id",
      typeof value === "string"
        ? requiredCollectionString(value, "collection ID")
        : parseCollectionData(client, value),
    );
    this.subreddit = subreddit;
  }

  get submissions(): readonly Submission[] {
    const links = this.get("sorted_links");
    if (
      !Array.isArray(links) ||
      !links.every((link) => link instanceof Submission)
    ) {
      throw new TypeError("Collection submissions have not been loaded");
    }
    return links;
  }

  get length(): number {
    const linkIds = this.get("link_ids");
    if (
      Array.isArray(linkIds) &&
      linkIds.every((id) => typeof id === "string")
    ) {
      return linkIds.length;
    }
    return this.submissions.length;
  }

  [Symbol.iterator](): Iterator<Submission> {
    return this.submissions[Symbol.iterator]();
  }

  override async refresh(options: LoadOptions = {}): Promise<this> {
    options.signal?.throwIfAborted();
    const response = await this.collectionsClient.request({
      method: "GET",
      path: "/api/v1/collections/collection",
      params: { collection_id: this.toString(), include_links: true },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    this.applyLoadedData(parseCollectionData(this.collectionsClient, response));
    return this;
  }

  follow(signal?: AbortSignal): Promise<void> {
    return this.mutate(
      "collection.follow()",
      "follow_collection",
      { follow: true },
      signal,
    );
  }

  unfollow(signal?: AbortSignal): Promise<void> {
    return this.mutate(
      "collection.unfollow()",
      "follow_collection",
      { follow: false },
      signal,
    );
  }

  addPost(
    submission: SubmissionReference,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.mutate(
      "collection.addPost()",
      "add_post_to_collection",
      { link_fullname: submissionFullname(submission) },
      signal,
    );
  }

  removePost(
    submission: SubmissionReference,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.mutate(
      "collection.removePost()",
      "remove_post_in_collection",
      { link_fullname: submissionFullname(submission) },
      signal,
    );
  }

  reorder(
    submissions: Iterable<SubmissionReference>,
    signal?: AbortSignal,
  ): Promise<void> {
    const linkIds = Array.from(submissions, submissionFullname);
    if (linkIds.length === 0)
      throw new TypeError("submissions cannot be empty");
    return this.mutate(
      "collection.reorder()",
      "reorder_collection",
      { link_ids: linkIds.join(",") },
      signal,
    );
  }

  updateTitle(title: string, signal?: AbortSignal): Promise<void> {
    const value = requiredCollectionString(title, "title");
    if (value.length > 300)
      throw new RangeError("title must be 300 characters or less");
    return this.mutate(
      "collection.updateTitle()",
      "update_collection_title",
      { title: value },
      signal,
    );
  }

  updateDescription(description: string, signal?: AbortSignal): Promise<void> {
    if (description.length > 500) {
      throw new RangeError("description must be 500 characters or less");
    }
    return this.mutate(
      "collection.updateDescription()",
      "update_collection_description",
      { description },
      signal,
    );
  }

  updateLayout(layout: CollectionLayout, signal?: AbortSignal): Promise<void> {
    validateCollectionLayout(layout);
    return this.mutate(
      "collection.updateLayout()",
      "update_collection_display_layout",
      { display_layout: layout },
      signal,
    );
  }

  delete(signal?: AbortSignal): Promise<void> {
    return this.mutate("collection.delete()", "delete_collection", {}, signal);
  }

  protected fetchRequest(): Pick<RedditRequest, "params" | "path"> {
    return {
      path: "/api/v1/collections/collection",
      params: { collection_id: this.toString(), include_links: true },
    };
  }

  private async mutate(
    operation: string,
    endpoint: string,
    data: Readonly<Record<string, boolean | string>>,
    signal?: AbortSignal,
  ): Promise<void> {
    assertCollectionAuthorized(this.collectionsClient, operation);
    signal?.throwIfAborted();
    const response = await this.collectionsClient.request({
      method: "POST",
      path: `/api/v1/collections/${endpoint}`,
      data: { collection_id: this.toString(), ...data },
      ...(signal === undefined ? {} : { signal }),
    });
    new Objector(this.collectionsClient).objectify(response);
  }

  private get collectionsClient(): CollectionsClient {
    return this.client;
  }
}
