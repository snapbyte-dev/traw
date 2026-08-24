import { ReadOnlyError } from "../exceptions.js";
import { Listing, type ListingOptions } from "../listing.js";
import { Comment } from "../models/entities.js";
import {
  Message,
  messageObjector,
  objectifyMessageThread,
  type MessageClient,
} from "../models/messages.js";
import { streamGenerator, type StreamOptions } from "../stream.js";

export type InboxItem = Comment | Message;
export type InboxReference = string | { readonly fullname: string };
export type InboxStreamOptions = StreamOptions<InboxItem>;

function assertAuthorized(client: MessageClient, operation: string): void {
  if (client.readOnly)
    throw new ReadOnlyError(`${operation} does not work in read-only mode`);
}

function fullname(value: InboxReference): string {
  const id = typeof value === "string" ? value : value.fullname;
  const normalized = id.trim();
  if (normalized.length === 0) throw new TypeError("fullname cannot be empty");
  return normalized;
}

export class InboxDomain {
  readonly #client: MessageClient;

  constructor(client: MessageClient) {
    this.#client = client;
  }

  all(options: ListingOptions = {}): Listing<InboxItem> {
    return this.listing("inbox.all()", "/message/inbox/", options);
  }

  unread(
    options: ListingOptions & { readonly markRead?: boolean } = {},
  ): Listing<InboxItem> {
    const { markRead = false, ...listingOptions } = options;
    return this.listing("inbox.unread()", "/message/unread/", {
      ...listingOptions,
      params: { ...listingOptions.params, mark: markRead },
    });
  }

  messages(options: ListingOptions = {}): Listing<Message> {
    return this.listing("inbox.messages()", "/message/messages/", options);
  }

  commentReplies(options: ListingOptions = {}): Listing<Comment> {
    return this.listing(
      "inbox.commentReplies()",
      "/message/comments/",
      options,
    );
  }

  submissionReplies(options: ListingOptions = {}): Listing<Comment> {
    return this.listing(
      "inbox.submissionReplies()",
      "/message/selfreply/",
      options,
    );
  }

  mentions(options: ListingOptions = {}): Listing<Comment> {
    return this.listing("inbox.mentions()", "/message/mentions", options);
  }

  sent(options: ListingOptions = {}): Listing<Message> {
    return this.listing("inbox.sent()", "/message/sent/", options);
  }

  async message(id: string, signal?: AbortSignal): Promise<Message> {
    assertAuthorized(this.#client, "inbox.message()");
    signal?.throwIfAborted();
    const normalized = fullname(id);
    const bareId = normalized.startsWith("t4_")
      ? normalized.slice(3)
      : normalized;
    const response = await this.#client.request({
      method: "GET",
      path: `/message/messages/${encodeURIComponent(bareId)}/`,
      ...(signal === undefined ? {} : { signal }),
    });
    const messages = objectifyMessageThread(this.#client, response);
    const target = `t4_${bareId}`.toLowerCase();
    const message = messages.find(
      (candidate) => candidate.fullname.toLowerCase() === target,
    );
    if (message === undefined)
      throw new TypeError(`Reddit response did not contain message ${bareId}`);
    return message;
  }

  markAllRead(signal?: AbortSignal): Promise<void> {
    return this.single("inbox.markAllRead()", "/api/read_all_messages", signal);
  }

  markRead(
    items: Iterable<InboxReference>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.batch("inbox.markRead()", "/api/read_message/", items, signal);
  }

  markUnread(
    items: Iterable<InboxReference>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.batch(
      "inbox.markUnread()",
      "/api/unread_message/",
      items,
      signal,
    );
  }

  collapse(
    items: Iterable<InboxReference>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.batch(
      "inbox.collapse()",
      "/api/collapse_message/",
      items,
      signal,
    );
  }

  uncollapse(
    items: Iterable<InboxReference>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.batch(
      "inbox.uncollapse()",
      "/api/uncollapse_message/",
      items,
      signal,
    );
  }

  stream(options: InboxStreamOptions = {}): AsyncGenerator<InboxItem | null> {
    assertAuthorized(this.#client, "inbox.stream()");
    return streamGenerator(
      ({ before, limit, signal }) =>
        this.unread({
          limit,
          ...(before === undefined ? {} : { params: { before } }),
          ...(signal === undefined ? {} : { signal }),
        }),
      options,
    );
  }

  private listing<T extends InboxItem>(
    operation: string,
    path: string,
    options: ListingOptions,
  ): Listing<T> {
    assertAuthorized(this.#client, operation);
    return new Listing<T>(this.#client, path, {
      ...options,
      objector: messageObjector(this.#client),
    });
  }

  private async single(
    operation: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertAuthorized(this.#client, operation);
    signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "POST",
      path,
      ...(signal === undefined ? {} : { signal }),
    });
    messageObjector(this.#client).objectify(response);
  }

  private async batch(
    operation: string,
    path: string,
    items: Iterable<InboxReference>,
    signal?: AbortSignal,
  ): Promise<void> {
    assertAuthorized(this.#client, operation);
    signal?.throwIfAborted();
    const ids = Array.from(items, fullname);
    for (let index = 0; index < ids.length; index += 25) {
      signal?.throwIfAborted();
      const response = await this.#client.request({
        method: "POST",
        path,
        data: { id: ids.slice(index, index + 25).join(",") },
        ...(signal === undefined ? {} : { signal }),
      });
      messageObjector(this.#client).objectify(response);
    }
  }
}
