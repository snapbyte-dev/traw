import {
  Listing,
  type ListingOptions,
  type ListingPageAdapter,
} from "../listing.js";
import { Objector } from "../objector.js";
import { SubredditRelationship } from "../domains/relationships.js";
import { Redditor, type Submission } from "./entities.js";
import { BaseModel, isRawData, type DataValue, type RawData } from "./base.js";
import {
  assertModeratorAccess,
  referenceString,
  requiredString,
  responseData,
  subredditName,
  subredditPath,
  type ModerationClientLike,
  type RedditorReference,
  type SubredditReference,
} from "./moderation.js";

export type WikiClientLike = ModerationClientLike;
export type WikiPermissionLevel = 0 | 1 | 2;

export interface WikiEditOptions {
  readonly previous?: string;
  readonly reason?: string;
}

export interface WikiSettings {
  readonly listed: boolean;
  readonly permlevel: number;
  readonly [field: string]: unknown;
}

export interface WikiSettingsUpdate {
  readonly listed: boolean;
  readonly permlevel: WikiPermissionLevel;
}

export function wikiPageName(value: string, create = false): string {
  let normalized = requiredString(value, "wiki page name").toLowerCase();
  if (create) normalized = normalized.replaceAll(" ", "_");
  if (normalized.length > 512)
    throw new RangeError("wiki page name cannot exceed 512 characters");
  return normalized;
}

function pagePath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

function revisionId(value: string): string {
  return requiredString(value, "wiki revision ID");
}

function reasonValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 256)
    throw new RangeError("wiki edit reason cannot exceed 256 characters");
  if (/[^\x20-\x7e]/u.test(value))
    throw new TypeError(
      "wiki edit reason must contain printable characters only",
    );
  return value;
}

function wikiData(value: unknown, description: string): RawData {
  const data = responseData(value, description);
  return typeof data["content_md"] === "string" ||
    typeof data["name"] === "string"
    ? data
    : responseData(data, description);
}

function authorFrom(value: unknown, client: WikiClientLike): Redditor | null {
  if (value === null || value === undefined) return null;
  let data = value;
  if (isRawData(data) && isRawData(data["data"])) data = data["data"];
  if (!isRawData(data))
    throw new TypeError("Reddit returned invalid wiki author data");
  return new Redditor(client, data);
}

const revisionPageAdapter: ListingPageAdapter = {
  childKind: "wiki_revision",
  childName: "wiki revision",
  cursorParam: "after",
  page(value: unknown) {
    let data = value;
    if (isRawData(data) && data["kind"] === "Listing") data = data["data"];
    if (!isRawData(data) || !Array.isArray(data["children"])) {
      throw new TypeError(
        "Reddit wiki revision response has no children array",
      );
    }
    const after = data["after"];
    if (after !== null && after !== undefined && typeof after !== "string") {
      throw new TypeError(
        "Reddit wiki revision cursor must be a string or null",
      );
    }
    return { children: data["children"], cursor: after ?? null };
  },
};

export class WikiRevision extends BaseModel {
  readonly subreddit: SubredditReference;
  readonly page: WikiPage;
  readonly author: Redditor | null;

  constructor(
    client: WikiClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    const id = data["id"];
    const page = data["page"];
    if (typeof id !== "string" || id.length === 0 || typeof page !== "string") {
      throw new TypeError("Reddit returned invalid wiki revision data");
    }
    const author = authorFrom(data["author"], client);
    super(client, { ...data, author });
    this.subreddit = subreddit;
    this.author = author;
    this.page = new WikiPage(client, subreddit, page, id);
  }

  override toString(): string {
    const id = this.get("id");
    if (typeof id !== "string" || id.length === 0)
      throw new TypeError("WikiRevision has no valid identity");
    return id;
  }
}

export class WikiPageEditors {
  readonly #page: WikiPage;
  readonly #contributors: SubredditRelationship;

  constructor(page: WikiPage) {
    this.#page = page;
    this.#contributors = new SubredditRelationship(
      page.client,
      page.subreddit,
      "wikicontributor",
    );
  }

  list(options: ListingOptions = {}): Listing<Redditor> {
    return this.#contributors.list(options);
  }

  async add(redditor: RedditorReference, signal?: AbortSignal): Promise<void> {
    await this.updateEditor("add", redditor, signal);
  }

  async remove(
    redditor: RedditorReference,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.updateEditor("del", redditor, signal);
  }

  revert(signal?: AbortSignal): Promise<void> {
    return this.#page.revert(signal);
  }

  settings(signal?: AbortSignal): Promise<WikiSettings> {
    return this.#page.settings(signal);
  }

  updateSettings(
    settings: WikiSettingsUpdate,
    signal?: AbortSignal,
  ): Promise<WikiSettings> {
    return this.#page.updateSettings(settings, signal);
  }

  private async updateEditor(
    action: "add" | "del",
    redditor: RedditorReference,
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#page.client, `wiki editors.${action}()`);
    signal?.throwIfAborted();
    await this.#page.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#page.subreddit)}/api/wiki/alloweditor/${action}`,
      data: {
        page: this.#page.name,
        username: referenceString(redditor, "redditor"),
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export class WikiPage extends BaseModel {
  readonly subreddit: SubredditReference;
  readonly name: string;
  readonly revisionId: string | undefined;
  readonly editors: WikiPageEditors;
  #loaded: boolean;

  constructor(
    client: WikiClientLike,
    subreddit: SubredditReference,
    name: string,
    revision?: string,
    data?: RawData,
  ) {
    const normalizedName = wikiPageName(name);
    super(
      client,
      data === undefined
        ? { name: normalizedName }
        : { ...data, name: normalizedName },
    );
    this.subreddit = subreddit;
    subredditName(subreddit);
    this.name = normalizedName;
    this.revisionId = revision === undefined ? undefined : revisionId(revision);
    this.#loaded = data !== undefined;
    this.editors = new WikiPageEditors(this);
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  override toString(): string {
    return `${subredditName(this.subreddit)}/${this.name}`;
  }

  async load(signal?: AbortSignal): Promise<this> {
    if (!this.#loaded) await this.hydrate(signal);
    return this;
  }

  private async hydrate(signal?: AbortSignal): Promise<this> {
    signal?.throwIfAborted();
    const response = await this.client.request({
      method: "GET",
      path: `/r/${subredditPath(this.subreddit)}/wiki/${pagePath(this.name)}`,
      ...(this.revisionId === undefined
        ? {}
        : { params: { v: this.revisionId } }),
      ...(signal === undefined ? {} : { signal }),
    });
    const data = wikiData(response, "wiki page");
    const revisionBy = authorFrom(data["revision_by"], this.client);
    this.applyData({ ...data, name: this.name, revision_by: revisionBy });
    this.#loaded = true;
    return this;
  }

  async edit(
    content: string,
    options: WikiEditOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.client, "wiki page.edit()");
    if (typeof content !== "string")
      throw new TypeError("wiki content must be a string");
    const reason = reasonValue(options.reason);
    const data: Record<string, DataValue> = { content, page: this.name };
    if (options.previous !== undefined)
      data["previous"] = revisionId(options.previous);
    if (reason !== undefined) data["reason"] = reason;
    signal?.throwIfAborted();
    await this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/api/wiki/edit`,
      data,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  discussions(options: ListingOptions = {}): Listing<Submission> {
    return new Listing(
      this.client,
      `/r/${subredditPath(this.subreddit)}/wiki/discussions/${pagePath(this.name)}`,
      options,
    );
  }

  revision(id: string): WikiPage {
    return new WikiPage(this.client, this.subreddit, this.name, revisionId(id));
  }

  revisions(options: ListingOptions = {}): Listing<WikiRevision> {
    return wikiRevisions(
      this.client,
      this.subreddit,
      `/r/${subredditPath(this.subreddit)}/wiki/revisions/${pagePath(this.name)}`,
      options,
    );
  }

  async revert(signal?: AbortSignal): Promise<void> {
    assertModeratorAccess(this.client, "wiki page.revert()");
    if (this.revisionId === undefined)
      throw new TypeError("A specific wiki revision is required to revert");
    signal?.throwIfAborted();
    await this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/api/wiki/revert`,
      data: { page: this.name, revision: this.revisionId },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async settings(signal?: AbortSignal): Promise<WikiSettings> {
    assertModeratorAccess(this.client, "wiki page.settings()");
    signal?.throwIfAborted();
    const response = await this.client.request({
      method: "GET",
      path: `/r/${subredditPath(this.subreddit)}/wiki/settings/${pagePath(this.name)}`,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseSettings(response);
  }

  async updateSettings(
    settings: WikiSettingsUpdate,
    signal?: AbortSignal,
  ): Promise<WikiSettings> {
    assertModeratorAccess(this.client, "wiki page.updateSettings()");
    if (typeof settings.listed !== "boolean")
      throw new TypeError("listed must be a boolean");
    if (![0, 1, 2].includes(settings.permlevel))
      throw new RangeError("permlevel must be 0, 1, or 2");
    signal?.throwIfAborted();
    const response = await this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/wiki/settings/${pagePath(this.name)}`,
      data: { listed: settings.listed, permlevel: settings.permlevel },
      ...(signal === undefined ? {} : { signal }),
    });
    return parseSettings(response);
  }
}

function parseSettings(value: unknown): WikiSettings {
  const data = responseData(value, "wiki page settings");
  if (
    typeof data["listed"] !== "boolean" ||
    typeof data["permlevel"] !== "number"
  ) {
    throw new TypeError("Reddit returned invalid wiki page settings data");
  }
  return data as WikiSettings;
}

export function wikiRevisions(
  client: WikiClientLike,
  subreddit: SubredditReference,
  path: string,
  options: ListingOptions = {},
): Listing<WikiRevision> {
  return new Listing(client, path, {
    ...options,
    objector: new Objector(client, {
      wiki_revision: (_client, data) =>
        new WikiRevision(client, subreddit, data),
    }),
    pageAdapter: revisionPageAdapter,
  });
}
