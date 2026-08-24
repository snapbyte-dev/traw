import { ReadOnlyError } from "../exceptions.js";
import {
  Listing,
  type ListingOptions,
  type ListingPage,
  type ListingPageAdapter,
} from "../listing.js";
import { isRawData, type QueryValue, type RawData } from "../models/base.js";
import { Redditor, Subreddit } from "../models/entities.js";
import {
  LegacyModmailMessage,
  ModmailConversation,
  parseModmailConversation,
  type ModmailClient,
} from "../models/modmail.js";
import { Objector } from "../objector.js";
import { streamGenerator, type StreamOptions } from "../stream.js";

export type ModmailSort = "mod" | "recent" | "unread" | "user";
export type ModmailState =
  | "admin"
  | "all"
  | "appeals"
  | "archived"
  | "default"
  | "filtered"
  | "highlighted"
  | "inbox"
  | "inprogress"
  | "join_requests"
  | "mod"
  | "new"
  | "notifications";

type SubredditValue = string | Subreddit;

export interface ModmailConversationOptions extends ListingOptions {
  readonly after?: string;
  readonly otherSubreddits?: readonly SubredditValue[];
  readonly sort?: ModmailSort;
  readonly state?: ModmailState;
}

export interface CreateModmailOptions {
  readonly authorHidden?: boolean;
  readonly body: string;
  readonly recipient: string | Redditor;
  readonly signal?: AbortSignal;
  readonly subject: string;
}

export interface BulkReadModmailOptions {
  readonly otherSubreddits?: readonly SubredditValue[];
  readonly signal?: AbortSignal;
  readonly state?: ModmailState;
}

export interface LegacySendOptions {
  readonly body: string;
  readonly recipient?: string | Redditor;
  readonly signal?: AbortSignal;
  readonly subject: string;
}

function authorized(client: ModmailClient, operation: string): void {
  if (client.readOnly)
    throw new ReadOnlyError(`${operation} does not work in read-only mode`);
}

function required(value: string, name: string): string {
  const result = value.trim();
  if (result.length === 0) throw new TypeError(`${name} cannot be empty`);
  return result;
}

function subreddit(value: SubredditValue): string {
  return required(String(value), "subreddit");
}

function envelope(value: unknown, name: string): RawData {
  if (!isRawData(value))
    throw new TypeError(`Reddit returned invalid ${name} data`);
  return value;
}

function entities(
  primary: string,
  others: readonly SubredditValue[] = [],
): string {
  return [primary, ...others.map(subreddit)].join(",");
}

const modmailPageAdapter: ListingPageAdapter = {
  childKind: "modmail_conversation",
  childName: "modmail conversation",
  cursorParam: "after",
  page(value: unknown): ListingPage {
    const data = envelope(value, "modmail conversations");
    const ids = data["conversationIds"];
    const conversations = data["conversations"];
    if (
      !Array.isArray(ids) ||
      !ids.every((item: unknown) => typeof item === "string") ||
      !isRawData(conversations)
    )
      throw new TypeError("Reddit returned invalid modmail conversations data");
    const conversationIds: unknown[] = ids;
    const children = conversationIds.map((value) => {
      const conversationId = value as string;
      const conversation = conversations[conversationId];
      if (!isRawData(conversation))
        throw new TypeError("Reddit omitted modmail conversation data");
      return {
        conversation,
        messages: data["messages"],
        modActions: data["modActions"],
      };
    });
    const cursor = conversationIds.at(-1);
    return {
      children,
      cursor: typeof cursor === "string" ? cursor : null,
    };
  },
};

export class ModmailDomain {
  readonly #client: ModmailClient;
  readonly #subreddit: string;

  constructor(client: ModmailClient, subredditValue: SubredditValue) {
    this.#client = client;
    this.#subreddit = subreddit(subredditValue);
  }

  async conversation(
    conversationId: string,
    options: {
      readonly markRead?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ModmailConversation> {
    authorized(this.#client, "modmail.conversation()");
    const normalizedId = required(conversationId, "conversation ID").replace(
      /^ModmailConversation_/,
      "",
    );
    options.signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: `/api/mod/conversations/${encodeURIComponent(normalizedId)}`,
      params: { markRead: options.markRead ?? false },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parseModmailConversation(this.#client, response, normalizedId);
  }

  conversations(
    options: ModmailConversationOptions = {},
  ): Listing<ModmailConversation> {
    authorized(this.#client, "modmail.conversations()");
    const {
      after,
      otherSubreddits = [],
      sort,
      state,
      ...listingOptions
    } = options;
    const params: Record<string, QueryValue> = { ...listingOptions.params };
    if (this.#subreddit.toLowerCase() !== "all")
      params["entity"] = entities(this.#subreddit, otherSubreddits);
    if (after !== undefined) params["after"] = required(after, "after cursor");
    if (sort !== undefined) params["sort"] = sort;
    if (state !== undefined) params["state"] = state;
    return new Listing(this.#client, "/api/mod/conversations/", {
      ...listingOptions,
      objector: new Objector(this.#client, {
        modmail_conversation: (client, data) =>
          parseModmailConversation(client as ModmailClient, data),
      }),
      pageAdapter: modmailPageAdapter,
      params,
      requestLimit: listingOptions.requestLimit ?? 100,
    });
  }

  async create(options: CreateModmailOptions): Promise<ModmailConversation> {
    authorized(this.#client, "modmail.create()");
    options.signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "POST",
      path: "/api/mod/conversations/",
      data: {
        body: required(options.body, "body"),
        isAuthorHidden: options.authorHidden ?? false,
        srName: this.#subreddit,
        subject: required(options.subject, "subject"),
        to: required(String(options.recipient), "recipient"),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parseModmailConversation(this.#client, response);
  }

  async subreddits(signal?: AbortSignal): Promise<Subreddit[]> {
    authorized(this.#client, "modmail.subreddits()");
    signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: "/api/mod/conversations/subreddits",
      ...(signal === undefined ? {} : { signal }),
    });
    const data = envelope(response, "modmail subreddits")["subreddits"];
    if (!isRawData(data))
      throw new TypeError("Reddit returned invalid modmail subreddits data");
    return Object.values(data).map((item) => {
      const raw = envelope(item, "modmail subreddit");
      if (typeof raw["displayName"] !== "string")
        throw new TypeError("Reddit returned invalid modmail subreddit data");
      return new Subreddit(this.#client, {
        ...raw,
        display_name: raw["displayName"],
      });
    });
  }

  async bulkRead(
    options: BulkReadModmailOptions = {},
  ): Promise<ModmailConversation[]> {
    authorized(this.#client, "modmail.bulkRead()");
    if (this.#subreddit.toLowerCase() === "all")
      throw new TypeError("bulkRead requires explicit subreddit names");
    options.signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "POST",
      path: "/api/mod/conversations/bulk/read",
      params: {
        entity: entities(this.#subreddit, options.otherSubreddits),
        state: options.state ?? "all",
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const ids =
      envelope(response, "bulk-read modmail")["conversationIds"] ??
      envelope(response, "bulk-read modmail")["conversation_ids"];
    if (!Array.isArray(ids) || !ids.every((item) => typeof item === "string"))
      throw new TypeError("Reddit returned invalid bulk-read modmail data");
    return ids.map((item) => new ModmailConversation(this.#client, item));
  }

  async unreadCount(
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, number>>> {
    authorized(this.#client, "modmail.unreadCount()");
    signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: "/api/mod/conversations/unread/count",
      ...(signal === undefined ? {} : { signal }),
    });
    const data = envelope(response, "modmail unread counts");
    const counts: Record<string, number> = {};
    for (const [state, value] of Object.entries(data)) {
      if (typeof value !== "number")
        throw new TypeError(
          "Reddit returned invalid modmail unread counts data",
        );
      counts[state] = value;
    }
    return counts;
  }

  stream(
    options: ModmailConversationOptions &
      StreamOptions<ModmailConversation> = {},
  ): AsyncGenerator<ModmailConversation | null> {
    const streamOptions: StreamOptions<ModmailConversation> = options;
    return streamGenerator(
      ({ limit, signal }) =>
        this.conversations({
          ...options,
          limit,
          ...(signal === undefined ? {} : { signal }),
        }),
      { ...streamOptions, attribute: "id", excludeBefore: true },
    );
  }
}

export class LegacyModmailDomain {
  readonly #client: ModmailClient;
  readonly #subreddit: string;

  constructor(client: ModmailClient, subredditValue: SubredditValue) {
    this.#client = client;
    this.#subreddit = subreddit(subredditValue);
  }

  inbox(options: ListingOptions = {}): Listing<LegacyModmailMessage> {
    return this.listing("mail", options);
  }

  list(options: ListingOptions = {}): Listing<LegacyModmailMessage> {
    return this.inbox(options);
  }

  unread(options: ListingOptions = {}): Listing<LegacyModmailMessage> {
    return this.listing("unread", options);
  }

  async send(options: LegacySendOptions): Promise<void> {
    authorized(this.#client, "legacy modmail send");
    options.signal?.throwIfAborted();
    await this.#client.request({
      method: "POST",
      path: "/api/compose",
      data: {
        ...(options.recipient === undefined
          ? {}
          : { from_sr: this.#subreddit }),
        subject: required(options.subject, "subject"),
        text: required(options.body, "body"),
        to:
          options.recipient === undefined
            ? `#${this.#subreddit}`
            : required(String(options.recipient), "recipient"),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  stream(
    options: ListingOptions & StreamOptions<LegacyModmailMessage> = {},
  ): AsyncGenerator<LegacyModmailMessage | null> {
    const streamOptions: StreamOptions<LegacyModmailMessage> = options;
    return streamGenerator(
      ({ before, limit, signal }) =>
        this.unread({
          ...options,
          limit,
          params: {
            ...options.params,
            ...(before === undefined ? {} : { before }),
          },
          ...(signal === undefined ? {} : { signal }),
        }),
      { ...streamOptions, attribute: "fullname" },
    );
  }

  private listing(
    queue: "mail" | "unread",
    options: ListingOptions,
  ): Listing<LegacyModmailMessage> {
    authorized(this.#client, `legacy modmail ${queue}()`);
    const suffix = queue === "unread" ? "unread/" : "";
    return new Listing(
      this.#client,
      `/r/${encodeURIComponent(this.#subreddit)}/message/moderator/${suffix}`,
      {
        ...options,
        objector: new Objector(this.#client, {
          t4: (client, data) =>
            new LegacyModmailMessage(client as ModmailClient, data),
        }),
      },
    );
  }
}
