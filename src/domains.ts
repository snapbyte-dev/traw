import { ReadOnlyException } from "./exceptions.js";
import {
  announcementsPageAdapter,
  Listing,
  moderatorNotesPageAdapter,
  type ListingOptions,
} from "./listing.js";
import { Objector } from "./objector.js";
import {
  BaseModel,
  isRawData,
  type RawData,
  type RedditClientLike,
} from "./models/base.js";
import { Comment, Message, Redditor, Subreddit } from "./models/entities.js";

interface DomainClient extends RedditClientLike {
  readonly readOnly: boolean;
}

type InboxItem = Comment | Message;
type Fullname = string | { readonly fullname: string };

function assertAuthorized(client: DomainClient, operation: string): void {
  if (client.readOnly)
    throw new ReadOnlyException(`${operation} does not work in read-only mode`);
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return normalized;
}

function segment(value: string, name: string): string {
  return encodeURIComponent(nonEmpty(value, name));
}

function fullname(value: Fullname): string {
  const result = typeof value === "string" ? value : value.fullname;
  return nonEmpty(result, "fullname");
}

function modelData(value: unknown, model: string): RawData {
  let data = value;
  if (isRawData(data) && isRawData(data["json"])) data = data["json"];
  if (isRawData(data) && isRawData(data["data"])) data = data["data"];
  if (isRawData(data)) return data;
  throw new TypeError(`Reddit returned invalid ${model} data`);
}

class IdentifiedModel extends BaseModel {
  readonly identityField: string;

  constructor(
    client: RedditClientLike,
    identityField: string,
    value: string | RawData,
  ) {
    super(
      client,
      typeof value === "string" ? { [identityField]: value } : value,
    );
    this.identityField = identityField;
  }

  override toString(): string {
    const value = this.get(this.identityField);
    if (typeof value !== "string" || value.length === 0)
      throw new TypeError(`${this.constructor.name} has no valid identity`);
    return value;
  }
}

export class Announcement extends IdentifiedModel {
  constructor(client: RedditClientLike, value: string | RawData) {
    super(client, "id", value);
  }

  get fullname(): string {
    const value = this.get("name");
    return typeof value === "string" ? value : this.toString();
  }
}

export class Draft extends IdentifiedModel {
  constructor(client: RedditClientLike, value: string | RawData) {
    super(client, "id", value);
  }
}

export class LiveThread extends IdentifiedModel {
  constructor(client: RedditClientLike, value: string | RawData) {
    super(client, "id", value);
  }
}

export class Multireddit extends IdentifiedModel {
  constructor(client: RedditClientLike, data: RawData) {
    super(client, "name", data);
  }

  get path(): string {
    const value = this.get("path");
    if (typeof value !== "string")
      throw new TypeError("Multireddit has no valid path");
    return value;
  }
}

export class ModNote extends IdentifiedModel {
  constructor(client: RedditClientLike, value: string | RawData) {
    super(client, "id", value);
  }
}

export class UserDomain {
  readonly #client: DomainClient;
  #me: Redditor | undefined;

  constructor(client: DomainClient) {
    this.#client = client;
  }

  async me(
    options: {
      readonly signal?: AbortSignal;
      readonly useCache?: boolean;
    } = {},
  ): Promise<Redditor> {
    assertAuthorized(this.#client, "user.me()");
    if (options.useCache !== false && this.#me !== undefined) return this.#me;
    const response = await this.#client.request({
      method: "GET",
      path: "/api/v1/me",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const objectified = new Objector(this.#client).objectify(response);
    if (objectified instanceof Redditor) this.#me = objectified;
    else this.#me = new Redditor(this.#client, modelData(response, "user"));
    return this.#me;
  }
}

export class InboxDomain {
  readonly #client: DomainClient;

  constructor(client: DomainClient) {
    this.#client = client;
  }

  all(options: ListingOptions = {}): Listing<InboxItem> {
    return this.listing("/message/inbox/", options);
  }

  unread(
    options: ListingOptions & { readonly markRead?: boolean } = {},
  ): Listing<InboxItem> {
    const { markRead = false, ...listingOptions } = options;
    return this.listing("/message/unread/", {
      ...listingOptions,
      params: { ...listingOptions.params, mark: markRead },
    });
  }

  messages(options: ListingOptions = {}): Listing<Message> {
    return this.listing<Message>("/message/messages/", options);
  }

  commentReplies(options: ListingOptions = {}): Listing<Comment> {
    return this.listing<Comment>("/message/comments/", options);
  }

  submissionReplies(options: ListingOptions = {}): Listing<Comment> {
    return this.listing<Comment>("/message/selfreply/", options);
  }

  mentions(options: ListingOptions = {}): Listing<Comment> {
    return this.listing<Comment>("/message/mentions", options);
  }

  sent(options: ListingOptions = {}): Listing<Message> {
    return this.listing<Message>("/message/sent/", options);
  }

  async markAllRead(signal?: AbortSignal): Promise<void> {
    assertAuthorized(this.#client, "inbox.markAllRead()");
    await this.#client.request({
      method: "POST",
      path: "/api/read_all_messages",
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async markAllUnread(
    items: Iterable<Fullname>,
    signal?: AbortSignal,
  ): Promise<void> {
    assertAuthorized(this.#client, "inbox.markAllUnread()");
    const values = Array.from(items, fullname);
    for (let index = 0; index < values.length; index += 25) {
      await this.#client.request({
        method: "POST",
        path: "/api/unread_message/",
        data: { id: values.slice(index, index + 25).join(",") },
        ...(signal === undefined ? {} : { signal }),
      });
    }
  }

  private listing<T extends InboxItem>(
    path: string,
    options: ListingOptions,
  ): Listing<T> {
    return new Listing<T>(this.#client, path, options);
  }
}

export class RedditorsDomain {
  readonly #client: RedditClientLike;

  constructor(client: RedditClientLike) {
    this.#client = client;
  }

  new(options: ListingOptions = {}): Listing<Redditor> {
    return new Listing(this.#client, "/users/new", options);
  }

  search(query: string, options: ListingOptions = {}): Listing<Redditor> {
    return new Listing(this.#client, "/users/search", {
      ...options,
      params: { ...options.params, q: nonEmpty(query, "query") },
    });
  }
}

export class SubredditsDomain {
  readonly #client: RedditClientLike;

  constructor(client: RedditClientLike) {
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
}

export interface AnnouncementsDomain {
  (options?: ListingOptions): Listing<Announcement>;
  list(options?: ListingOptions): Listing<Announcement>;
  markAllRead(signal?: AbortSignal): Promise<void>;
}

export function createAnnouncementsDomain(
  client: DomainClient,
): AnnouncementsDomain {
  const list = (options: ListingOptions = {}): Listing<Announcement> => {
    const requestLimit =
      options.requestLimit ?? Math.max(1, Math.min(options.limit ?? 100, 100));
    const objector = new Objector(client, {
      ann: (modelClient, data) => new Announcement(modelClient, data),
      Announcement: (modelClient, data) => new Announcement(modelClient, data),
    });
    return new Listing(client, "/api/announcements/v1", {
      ...options,
      objector,
      pageAdapter: announcementsPageAdapter,
      requestLimit,
    });
  };
  return Object.assign(list, {
    list,
    async markAllRead(signal?: AbortSignal): Promise<void> {
      assertAuthorized(client, "announcements.markAllRead()");
      await client.request({
        method: "POST",
        path: "/api/announcements/v1/read_all",
        ...(signal === undefined ? {} : { signal }),
      });
    },
  });
}

export interface DraftCreateOptions {
  readonly flairId?: string;
  readonly flairText?: string;
  readonly isPublicLink?: boolean;
  readonly nsfw?: boolean;
  readonly originalContent?: boolean;
  readonly selftext?: string;
  readonly sendReplies?: boolean;
  readonly spoiler?: boolean;
  readonly subreddit?: string | Subreddit;
  readonly title?: string;
  readonly url?: string;
}

export interface DraftsDomain {
  (): Promise<Draft[]>;
  (id: string): Draft;
  list(signal?: AbortSignal): Promise<Draft[]>;
  create(options: DraftCreateOptions, signal?: AbortSignal): Promise<Draft>;
}

export function createDraftsDomain(client: DomainClient): DraftsDomain {
  const list = async (signal?: AbortSignal): Promise<Draft[]> => {
    assertAuthorized(client, "drafts()");
    const response = await client.request({
      method: "GET",
      path: "/api/v1/drafts",
      params: { md_body: true },
      ...(signal === undefined ? {} : { signal }),
    });
    let drafts: unknown = response;
    if (isRawData(drafts) && isRawData(drafts["data"])) drafts = drafts["data"];
    if (isRawData(drafts) && Array.isArray(drafts["drafts"]))
      drafts = drafts["drafts"];
    if (!Array.isArray(drafts))
      throw new TypeError("Reddit returned invalid drafts data");
    return drafts.map((draft) => new Draft(client, modelData(draft, "draft")));
  };
  const domain = ((id?: string): Draft | Promise<Draft[]> =>
    id === undefined
      ? list()
      : new Draft(client, nonEmpty(id, "draft ID"))) as DraftsDomain;
  domain.list = list;
  domain.create = async (
    options: DraftCreateOptions,
    signal?: AbortSignal,
  ): Promise<Draft> => {
    assertAuthorized(client, "drafts.create()");
    if (options.selftext !== undefined && options.url !== undefined)
      throw new TypeError("Exactly one of selftext or url may be provided");
    if (options.flairText !== undefined && options.flairId === undefined)
      throw new TypeError("flairId is required when flairText is provided");
    const subreddit = options.subreddit;
    const subredditName =
      subreddit === undefined
        ? undefined
        : nonEmpty(String(subreddit), "subreddit");
    const data: Record<string, boolean | string> = {
      is_public_link: options.isPublicLink ?? false,
      kind: options.selftext !== undefined ? "markdown" : "link",
      nsfw: options.nsfw ?? false,
      original_content: options.originalContent ?? false,
      send_replies: options.sendReplies ?? true,
      spoiler: options.spoiler ?? false,
    };
    if (options.selftext !== undefined) data["body"] = options.selftext;
    else if (options.url !== undefined) data["body"] = options.url;
    if (options.flairId !== undefined) data["flair_id"] = options.flairId;
    if (options.flairText !== undefined) data["flair_text"] = options.flairText;
    if (options.title !== undefined) data["title"] = options.title;
    if (subredditName !== undefined) {
      data["subreddit"] = subredditName;
      data["target"] = subredditName.startsWith("u_") ? "profile" : "subreddit";
    }
    const response = await client.request({
      method: "POST",
      path: "/api/v1/draft",
      data,
      ...(signal === undefined ? {} : { signal }),
    });
    return new Draft(client, modelData(response, "draft"));
  };
  return domain;
}

export interface LiveCreateOptions {
  readonly description?: string;
  readonly nsfw?: boolean;
  readonly resources?: string;
}

export interface LiveDomain {
  (id: string): LiveThread;
  create(
    title: string,
    options?: LiveCreateOptions,
    signal?: AbortSignal,
  ): Promise<LiveThread>;
}

export function createLiveDomain(client: DomainClient): LiveDomain {
  const domain = ((id: string) =>
    new LiveThread(client, nonEmpty(id, "live thread ID"))) as LiveDomain;
  domain.create = async (
    title: string,
    options: LiveCreateOptions = {},
    signal?: AbortSignal,
  ): Promise<LiveThread> => {
    assertAuthorized(client, "live.create()");
    const data: Record<string, boolean | string> = {
      nsfw: options.nsfw ?? false,
      title: nonEmpty(title, "title"),
    };
    if (options.description !== undefined)
      data["description"] = options.description;
    if (options.resources !== undefined) data["resources"] = options.resources;
    const response = await client.request({
      method: "POST",
      path: "/api/live/create",
      data,
      ...(signal === undefined ? {} : { signal }),
    });
    return new LiveThread(client, modelData(response, "live thread"));
  };
  return domain;
}

export interface MultiredditOptions {
  readonly name: string;
  readonly redditor: string | Redditor;
}

export interface MultiredditDomain {
  (options: MultiredditOptions): Multireddit;
  (redditor: string | Redditor, name: string): Multireddit;
}

export function createMultiredditDomain(
  client: RedditClientLike,
): MultiredditDomain {
  return (
    first: MultiredditOptions | string | Redditor,
    second?: string,
  ): Multireddit => {
    const redditor =
      typeof first === "object" && !(first instanceof Redditor)
        ? first.redditor
        : first;
    const name =
      typeof first === "object" && !(first instanceof Redditor)
        ? first.name
        : second;
    if (name === undefined) throw new TypeError("multireddit name is required");
    const owner = nonEmpty(String(redditor), "redditor");
    const normalizedName = nonEmpty(name, "multireddit name");
    return new Multireddit(client, {
      name: normalizedName,
      path: `/user/${segment(owner, "redditor")}/m/${segment(normalizedName, "multireddit name")}`,
    });
  };
}

export interface NotesOptions extends ListingOptions {
  readonly redditor: string | Redditor;
  readonly subreddit: string | Subreddit;
}

export interface NotesDomain {
  (options: NotesOptions): Listing<ModNote>;
  list(options: NotesOptions): Listing<ModNote>;
}

export function createNotesDomain(client: DomainClient): NotesDomain {
  const list = (options: NotesOptions): Listing<ModNote> => {
    assertAuthorized(client, "notes()");
    const { redditor, subreddit, ...listingOptions } = options;
    return new Listing(client, "/api/mod/notes", {
      ...listingOptions,
      objector: new Objector(client, {
        mod_note: (modelClient, data) => new ModNote(modelClient, data),
      }),
      pageAdapter: moderatorNotesPageAdapter,
      params: {
        ...listingOptions.params,
        subreddit: nonEmpty(String(subreddit), "subreddit"),
        user: nonEmpty(String(redditor), "redditor"),
      },
    });
  };
  return Object.assign(list, { list });
}
