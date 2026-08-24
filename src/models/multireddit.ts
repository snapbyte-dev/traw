import { ReadOnlyException } from "../exceptions.js";
import { Listing, type ListingOptions } from "../listing.js";
import {
  BaseModel,
  isRawData,
  type RawData,
  type RedditClientLike,
} from "./base.js";
import { Comment, Redditor, Submission, Subreddit } from "./entities.js";
import {
  listingStream,
  type ContentStream,
  type StreamFetchOptions,
  type StreamOptions,
} from "../stream.js";

export interface MultiredditClient extends RedditClientLike {
  readonly readOnly: boolean;
}

export type MultiredditVisibility = "hidden" | "private" | "public";
export type MultiredditWeightingScheme = "classic" | "fresh";
export type MultiredditIcon =
  | "art and design"
  | "ask"
  | "books"
  | "business"
  | "cars"
  | "comics"
  | "cute animals"
  | "diy"
  | "entertainment"
  | "food and drink"
  | "funny"
  | "games"
  | "grooming"
  | "health"
  | "life advice"
  | "military"
  | "models pinup"
  | "music"
  | "news"
  | "philosophy"
  | "pictures and gifs"
  | "science"
  | "shopping"
  | "sports"
  | "style"
  | "tech"
  | "travel"
  | "unusual stories"
  | "video";

export type SubredditReference = string | Subreddit | { readonly name: string };

export interface MultiredditUpdateOptions {
  readonly descriptionMd?: string | null;
  readonly displayName?: string;
  readonly iconName?: MultiredditIcon | null;
  readonly keyColor?: string | null;
  readonly signal?: AbortSignal;
  readonly subreddits?: readonly SubredditReference[];
  readonly visibility?: MultiredditVisibility;
  readonly weightingScheme?: MultiredditWeightingScheme;
}

export interface MultiredditCopyOptions {
  readonly descriptionMd?: string;
  readonly displayName?: string;
  readonly signal?: AbortSignal;
}

export interface MultiredditRenameOptions {
  readonly displayName?: string;
  readonly signal?: AbortSignal;
}

export interface SortedMultiredditListingOptions extends ListingOptions {
  readonly timeFilter?: "all" | "day" | "hour" | "month" | "week" | "year";
}

const ICONS = new Set<MultiredditIcon>([
  "art and design",
  "ask",
  "books",
  "business",
  "cars",
  "comics",
  "cute animals",
  "diy",
  "entertainment",
  "food and drink",
  "funny",
  "games",
  "grooming",
  "health",
  "life advice",
  "military",
  "models pinup",
  "music",
  "news",
  "philosophy",
  "pictures and gifs",
  "science",
  "shopping",
  "sports",
  "style",
  "tech",
  "travel",
  "unusual stories",
  "video",
]);
const TIME_FILTERS = new Set(["all", "day", "hour", "month", "week", "year"]);
const UPDATE_KEYS = new Set([
  "descriptionMd",
  "displayName",
  "iconName",
  "keyColor",
  "signal",
  "subreddits",
  "visibility",
  "weightingScheme",
]);

function assertAuthorized(client: MultiredditClient, operation: string): void {
  if (client.readOnly)
    throw new ReadOnlyException(`${operation} does not work in read-only mode`);
}

export function requiredMultiredditString(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return normalized;
}

export function assertExactOptions(
  options: object,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new TypeError(
      `${name} received unknown option: ${unknown.join(", ")}`,
    );
}

function pathPart(value: string, name: string): string {
  return encodeURIComponent(requiredMultiredditString(value, name));
}

export function multiredditPath(owner: string, name: string): string {
  return `/user/${pathPart(owner, "redditor")}/m/${pathPart(name, "multireddit name")}`;
}

function pathIdentity(path: string): { owner: string; name: string } {
  const match = /^\/?user\/([^/]+)\/m\/([^/]+)\/?$/i.exec(path);
  if (match?.[1] === undefined || match[2] === undefined)
    throw new TypeError("Multireddit has no valid path");
  return {
    owner: decodeURIComponent(match[1]),
    name: decodeURIComponent(match[2]),
  };
}

function subredditName(value: SubredditReference): string {
  const candidate =
    typeof value === "string"
      ? value
      : value instanceof Subreddit
        ? value.toString()
        : value.name;
  return requiredMultiredditString(candidate, "subreddit");
}

function modelData(value: unknown): RawData {
  let data = value;
  if (isRawData(data) && data["kind"] === "LabeledMulti") data = data["data"];
  if (isRawData(data) && isRawData(data["data"])) data = data["data"];
  if (!isRawData(data))
    throw new TypeError("Reddit returned invalid multireddit data");
  if (typeof data["name"] !== "string" || typeof data["path"] !== "string")
    throw new TypeError("Reddit returned invalid multireddit data");
  pathIdentity(data["path"]);
  return data;
}

function objectifiedData(client: RedditClientLike, value: unknown): RawData {
  const data = modelData(value);
  const result = { ...data };
  if ("subreddits" in data) {
    if (!Array.isArray(data["subreddits"]))
      throw new TypeError(
        "Reddit returned invalid multireddit subreddits data",
      );
    result["subreddits"] = data["subreddits"].map((item) => {
      if (item instanceof Subreddit) return item;
      if (!isRawData(item) || typeof item["name"] !== "string")
        throw new TypeError(
          "Reddit returned invalid multireddit subreddit data",
        );
      return new Subreddit(client, { ...item, display_name: item["name"] });
    });
  }
  return result;
}

function updateModel(options: MultiredditUpdateOptions): RawData {
  assertExactOptions(options, UPDATE_KEYS, "multireddit update");
  const model: RawData = {};
  if (options.displayName !== undefined) {
    const displayName = requiredMultiredditString(
      options.displayName,
      "displayName",
    );
    if (displayName.length > 50)
      throw new RangeError("displayName must be 50 characters or less");
    model["display_name"] = displayName;
  }
  if (options.descriptionMd !== undefined)
    model["description_md"] = options.descriptionMd;
  if (options.iconName !== undefined) {
    if (options.iconName !== null && !ICONS.has(options.iconName))
      throw new RangeError(`Invalid multireddit icon: ${options.iconName}`);
    model["icon_name"] = options.iconName;
  }
  if (options.keyColor !== undefined) {
    if (options.keyColor !== null && !/^#[0-9a-f]{6}$/i.test(options.keyColor))
      throw new TypeError("keyColor must be a six-digit RGB hex color");
    model["key_color"] = options.keyColor;
  }
  if (options.subreddits !== undefined)
    model["subreddits"] = options.subreddits.map((item) => ({
      name: subredditName(item),
    }));
  if (options.visibility !== undefined) {
    if (!["hidden", "private", "public"].includes(options.visibility))
      throw new RangeError(
        `Invalid multireddit visibility: ${options.visibility}`,
      );
    model["visibility"] = options.visibility;
  }
  if (options.weightingScheme !== undefined) {
    if (!["classic", "fresh"].includes(options.weightingScheme))
      throw new RangeError(
        `Invalid multireddit weighting scheme: ${options.weightingScheme}`,
      );
    model["weighting_scheme"] = options.weightingScheme;
  }
  return model;
}

function listingOptions(
  options: SortedMultiredditListingOptions,
): ListingOptions {
  const { timeFilter = "all", ...rest } = options;
  if (!TIME_FILTERS.has(timeFilter))
    throw new RangeError(`Invalid time filter: ${timeFilter}`);
  return { ...rest, params: { ...rest.params, t: timeFilter } };
}

function streamListingOptions(options: StreamFetchOptions): ListingOptions {
  return {
    limit: options.limit,
    params: options.before === undefined ? {} : { before: options.before },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/** A response-backed custom feed with explicit hydration and lifecycle methods. */
export class Multireddit extends BaseModel {
  readonly stream: MultiredditStream;
  #loaded: boolean;

  constructor(client: MultiredditClient, value: RawData) {
    const data = objectifiedData(client, value);
    super(client, data);
    this.#loaded = Object.keys(value).some(
      (key) => key !== "name" && key !== "path",
    );
    this.stream = new MultiredditStream(this);
  }

  get name(): string {
    const value = this.get("name");
    if (typeof value !== "string")
      throw new TypeError("Multireddit has no valid name");
    return value;
  }

  get path(): string {
    const value = this.get("path");
    if (typeof value !== "string")
      throw new TypeError("Multireddit has no valid path");
    pathIdentity(value);
    return value.startsWith("/")
      ? value.replace(/\/$/, "")
      : `/${value.replace(/\/$/, "")}`;
  }

  get owner(): Redditor {
    return new Redditor(this.client, pathIdentity(this.path).owner);
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  override toString(): string {
    return this.path;
  }

  async load(options: { readonly signal?: AbortSignal } = {}): Promise<this> {
    if (!this.#loaded) await this.refresh(options);
    return this;
  }

  async refresh(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<this> {
    assertExactOptions(options, new Set(["signal"]), "multireddit load");
    options.signal?.throwIfAborted();
    const response = await this.client.request({
      method: "GET",
      path: `/api/multi${this.path}/`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    this.applyMultireddit(response);
    return this;
  }

  hot(options: ListingOptions = {}): Listing<Submission> {
    return new Listing(this.client, `${this.path}/hot`, options);
  }

  new(options: ListingOptions = {}): Listing<Submission> {
    return new Listing(this.client, `${this.path}/new`, options);
  }

  rising(options: ListingOptions = {}): Listing<Submission> {
    return new Listing(this.client, `${this.path}/rising`, options);
  }

  top(options: SortedMultiredditListingOptions = {}): Listing<Submission> {
    return new Listing(
      this.client,
      `${this.path}/top`,
      listingOptions(options),
    );
  }

  controversial(
    options: SortedMultiredditListingOptions = {},
  ): Listing<Submission> {
    return new Listing(
      this.client,
      `${this.path}/controversial`,
      listingOptions(options),
    );
  }

  comments(options: ListingOptions = {}): Listing<Comment> {
    return new Listing(this.client, `${this.path}/comments`, options);
  }

  async add(
    subreddit: SubredditReference,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    assertExactOptions(options, new Set(["signal"]), "multireddit add");
    assertAuthorized(this.multiredditClient, "multireddit.add()");
    options.signal?.throwIfAborted();
    const name = subredditName(subreddit);
    await this.client.request({
      method: "PUT",
      path: `/api/multi${this.path}/r/${pathPart(name, "subreddit")}`,
      data: { model: JSON.stringify({ name }) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const current = this.get<unknown[]>("subreddits");
    if (
      Array.isArray(current) &&
      !current.some(
        (item) =>
          item instanceof Subreddit &&
          item.toString().toLowerCase() === name.toLowerCase(),
      )
    ) {
      this.applyData({
        subreddits: [...current, new Subreddit(this.client, name)],
      });
    }
  }

  async remove(
    subreddit: SubredditReference,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    assertExactOptions(options, new Set(["signal"]), "multireddit remove");
    assertAuthorized(this.multiredditClient, "multireddit.remove()");
    options.signal?.throwIfAborted();
    const name = subredditName(subreddit);
    await this.client.request({
      method: "DELETE",
      path: `/api/multi${this.path}/r/${pathPart(name, "subreddit")}`,
      data: { model: JSON.stringify({ name }) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const current = this.get<unknown[]>("subreddits");
    if (Array.isArray(current)) {
      this.applyData({
        subreddits: current.filter(
          (item) =>
            !(item instanceof Subreddit) ||
            item.toString().toLowerCase() !== name.toLowerCase(),
        ),
      });
    }
  }

  async update(options: MultiredditUpdateOptions): Promise<this> {
    assertAuthorized(this.multiredditClient, "multireddit.update()");
    options.signal?.throwIfAborted();
    const model = updateModel(options);
    if (Object.keys(model).length === 0)
      throw new TypeError("multireddit update requires at least one setting");
    const response = await this.client.request({
      method: "PUT",
      path: `/api/multi${this.path}/`,
      data: { model: JSON.stringify(model) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    this.applyMultireddit(response);
    return this;
  }

  async copy(options: MultiredditCopyOptions = {}): Promise<Multireddit> {
    assertExactOptions(
      options,
      new Set(["descriptionMd", "displayName", "signal"]),
      "multireddit copy",
    );
    assertAuthorized(this.multiredditClient, "multireddit.copy()");
    options.signal?.throwIfAborted();
    const displayName =
      options.displayName ?? this.get<string>("display_name") ?? this.name;
    const checkedDisplayName = requiredMultiredditString(
      displayName,
      "displayName",
    );
    if (checkedDisplayName.length > 50)
      throw new RangeError("displayName must be 50 characters or less");
    const me = await this.client.request({
      method: "GET",
      path: "/api/v1/me",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let meData = me;
    if (isRawData(meData) && isRawData(meData["data"])) meData = meData["data"];
    if (!isRawData(meData) || typeof meData["name"] !== "string")
      throw new TypeError("Reddit returned invalid current redditor data");
    const response = await this.client.request({
      method: "POST",
      path: "/api/multi/copy/",
      data: {
        display_name: checkedDisplayName,
        from: this.path,
        to: multiredditPath(
          meData["name"],
          Multireddit.sluggify(checkedDisplayName),
        ),
        ...(options.descriptionMd === undefined
          ? {}
          : { description_md: options.descriptionMd }),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return new Multireddit(this.multiredditClient, modelData(response));
  }

  async rename(
    name: string,
    options: MultiredditRenameOptions = {},
  ): Promise<Multireddit> {
    assertExactOptions(
      options,
      new Set(["displayName", "signal"]),
      "multireddit rename",
    );
    assertAuthorized(this.multiredditClient, "multireddit.rename()");
    options.signal?.throwIfAborted();
    const normalized = requiredMultiredditString(name, "multireddit name");
    if (
      options.displayName !== undefined &&
      options.displayName.trim().length > 50
    )
      throw new RangeError("displayName must be 50 characters or less");
    const destination = multiredditPath(String(this.owner), normalized);
    const response = await this.client.request({
      method: "POST",
      path: "/api/multi/rename/",
      data: {
        from: this.path,
        to: destination,
        ...(options.displayName === undefined
          ? {}
          : {
              display_name: requiredMultiredditString(
                options.displayName,
                "displayName",
              ),
            }),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return new Multireddit(this.multiredditClient, modelData(response));
  }

  async delete(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    assertExactOptions(options, new Set(["signal"]), "multireddit delete");
    assertAuthorized(this.multiredditClient, "multireddit.delete()");
    options.signal?.throwIfAborted();
    await this.client.request({
      method: "DELETE",
      path: `/api/multi${this.path}/`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  static sluggify(title: string): string {
    let slug = title
      .replace(/[\W_]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
    if (slug.length > 21) {
      slug = slug.slice(0, 21);
      const boundary = slug.lastIndexOf("_");
      if (boundary > 0) slug = slug.slice(0, boundary);
    }
    return slug || "_";
  }

  private get multiredditClient(): MultiredditClient {
    return this.client as MultiredditClient;
  }

  private applyMultireddit(response: unknown): void {
    this.applyData(objectifiedData(this.client, response));
    this.#loaded = true;
  }
}

export class MultiredditStream {
  readonly multireddit: Multireddit;

  constructor(multireddit: Multireddit) {
    this.multireddit = multireddit;
  }

  comments(options: StreamOptions<Comment> = {}): ContentStream<Comment> {
    return listingStream(
      (fetchOptions) =>
        this.multireddit.comments(streamListingOptions(fetchOptions)),
      options,
    );
  }

  submissions(
    options: StreamOptions<Submission> = {},
  ): ContentStream<Submission> {
    return listingStream(
      (fetchOptions) =>
        this.multireddit.new(streamListingOptions(fetchOptions)),
      options,
    );
  }
}

export function parseMultireddit(
  client: MultiredditClient,
  value: unknown,
): Multireddit {
  return new Multireddit(client, modelData(value));
}

export function parseMultiredditList(
  client: MultiredditClient,
  value: unknown,
): Multireddit[] {
  let items = value;
  if (isRawData(items) && Array.isArray(items["children"]))
    items = items["children"];
  if (!Array.isArray(items))
    throw new TypeError("Reddit returned invalid multireddit list data");
  return items.map((item) => parseMultireddit(client, item));
}

export function multiredditUpdateModel(
  options: MultiredditUpdateOptions,
): RawData {
  return updateModel(options);
}
