import { ReadOnlyError } from "../exceptions.js";
import { Objector } from "../objector.js";
import {
  isRawData,
  postRequest,
  type LoadOptions,
  type RawData,
  type RedditClientLike,
  type RedditRequest,
} from "./base.js";
import { Comment, Redditor, Subreddit } from "./entities.js";
import { MessageBase } from "./message-base.js";
import type { ActionOptions } from "./mixins.js";

export interface MessageClient extends RedditClientLike {
  readonly readOnly: boolean;
}

export type MessageReply = Comment | Message | null;

function assertAuthorized(client: MessageClient, operation: string): void {
  if (client.readOnly)
    throw new ReadOnlyError(`${operation} does not work in read-only mode`);
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return normalized;
}

function bareId(value: string): string {
  return value.startsWith("t4_") ? value.slice(3) : value;
}

function listingChildren(value: unknown): unknown[] {
  let data = value;
  if (isRawData(data) && data["kind"] === "Listing") data = data["data"];
  if (!isRawData(data) || !Array.isArray(data["children"]))
    throw new TypeError("Reddit message response has no children array");
  return data["children"];
}

function thingData(value: unknown): RawData {
  if (value instanceof Message) return { ...value.raw };
  if (isRawData(value) && value["kind"] === "t4" && isRawData(value["data"]))
    return value["data"];
  if (isRawData(value)) return value;
  throw new TypeError("Reddit returned invalid message data");
}

function findReply(value: unknown): MessageReply | undefined {
  if (value instanceof Comment || value instanceof Message) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findReply(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRawData(value)) return undefined;
  for (const key of ["json", "data", "things", "children"] as const) {
    const found = findReply(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function objectifiedMessageData(client: MessageClient, data: RawData): RawData {
  const result = { ...data };
  const author = data["author"];
  if (typeof author === "string")
    result["author"] = new Redditor(client, author);
  const destination = data["dest"];
  if (typeof destination === "string") {
    result["dest"] = destination.startsWith("#")
      ? new Subreddit(client, destination.slice(1))
      : new Redditor(client, destination);
  }
  const subreddit = data["subreddit"];
  if (typeof subreddit === "string")
    result["subreddit"] = new Subreddit(client, subreddit);
  return result;
}

export class Message extends MessageBase {
  declare author: unknown;
  declare body: unknown;
  declare dest: unknown;
  declare parent_id: unknown;
  declare replies: unknown;
  declare subject: unknown;
  #parent: Message | null = null;

  constructor(client: MessageClient, value: string | RawData) {
    const data =
      typeof value === "string"
        ? bareId(nonEmpty(value, "message ID"))
        : objectifiedMessageData(client, value);
    super(client, data);
    if (typeof data !== "string") this.applyThreadReplies(data);
  }

  static parse(client: MessageClient, data: RawData): Message {
    const Model = data["subreddit"] ? SubredditMessage : Message;
    return new Model(client, data);
  }

  override get fullname(): string {
    const name = this.get("name");
    return typeof name === "string" ? name : `t4_${this.toString()}`;
  }

  get parent(): Message | null {
    return this.#parent;
  }

  get thread(): readonly Message[] {
    return this.parent === null ? [this] : [...this.parent.thread, this];
  }

  setParent(parent: Message | null): void {
    this.#parent = parent;
  }

  override async refresh(options: LoadOptions = {}): Promise<this> {
    assertAuthorized(this.messageClient, "message.refresh()");
    options.signal?.throwIfAborted();
    const response = await this.messageClient.request({
      method: "GET",
      path: `/message/messages/${encodeURIComponent(this.toString())}/`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const messages = objectifyMessageThread(this.messageClient, response);
    const found = messages.find(
      (message) =>
        message.fullname.toLowerCase() === this.fullname.toLowerCase(),
    );
    if (found === undefined)
      throw new TypeError("Reddit response did not contain Message data");
    this.applyLoadedData({ ...found.raw });
    this.#parent = found.parent;
    this.applyThreadReplies(found.raw);
    return this;
  }

  async reply(
    body: string,
    options: ActionOptions = {},
  ): Promise<MessageReply> {
    assertAuthorized(this.messageClient, "message.reply()");
    nonEmpty(body, "body");
    const response = await postRequest(
      this.messageClient,
      "/api/comment",
      { text: body, thing_id: this.fullname },
      options.signal,
    );
    const objectified = messageObjector(this.messageClient).objectify(response);
    return findReply(objectified) ?? null;
  }

  block(options: ActionOptions = {}): Promise<unknown> {
    return this.action("message.block()", "/api/block", options);
  }

  collapse(options: ActionOptions = {}): Promise<unknown> {
    return this.action("message.collapse()", "/api/collapse_message/", options);
  }

  uncollapse(options: ActionOptions = {}): Promise<unknown> {
    return this.action(
      "message.uncollapse()",
      "/api/uncollapse_message/",
      options,
    );
  }

  markRead(options: ActionOptions = {}): Promise<unknown> {
    return this.action("message.markRead()", "/api/read_message/", options);
  }

  markUnread(options: ActionOptions = {}): Promise<unknown> {
    return this.action("message.markUnread()", "/api/unread_message/", options);
  }

  delete(options: ActionOptions = {}): Promise<unknown> {
    return this.action("message.delete()", "/api/del_msg", options);
  }

  protected override fetchRequest(): Pick<RedditRequest, "path"> {
    return {
      path: `/message/messages/${encodeURIComponent(this.toString())}/`,
    };
  }

  private get messageClient(): MessageClient {
    return this.client as MessageClient;
  }

  private async action(
    operation: string,
    path: string,
    options: ActionOptions,
  ): Promise<unknown> {
    assertAuthorized(this.messageClient, operation);
    const response = await postRequest(
      this.messageClient,
      path,
      { id: this.fullname },
      options.signal,
    );
    return messageObjector(this.messageClient).objectify(response);
  }

  private applyThreadReplies(data: RawData): void {
    const rawReplies = data["replies"];
    if (rawReplies === undefined || rawReplies === "" || rawReplies === null) {
      this.applyData({ replies: [] });
      return;
    }
    if (
      Array.isArray(rawReplies) &&
      rawReplies.every((item) => item instanceof Message)
    ) {
      for (const reply of rawReplies) {
        if (reply.get("parent_id") === this.fullname) reply.setParent(this);
      }
      this.applyData({ replies: rawReplies });
      return;
    }
    const children = Array.isArray(rawReplies)
      ? rawReplies
      : listingChildren(rawReplies);
    const replies = children.map((child) =>
      Message.parse(this.messageClient, thingData(child)),
    );
    for (const reply of replies) {
      if (reply.get("parent_id") === this.fullname) reply.setParent(this);
    }
    this.applyData({ replies });
  }
}

export class SubredditMessage extends Message {}

export function objectifyMessage(
  client: RedditClientLike,
  data: RawData,
): Message {
  return Message.parse(client as MessageClient, data);
}

export function messageObjector(client: MessageClient): Objector {
  return new Objector(client, { t4: objectifyMessage });
}

export function objectifyMessageThread(
  client: MessageClient,
  response: unknown,
): Message[] {
  const objectified = messageObjector(client).objectify(response);
  let children: unknown[];
  if (isRawData(objectified) && Array.isArray(objectified["children"]))
    children = objectified["children"];
  else if (Array.isArray(objectified)) children = objectified;
  else throw new TypeError("Reddit message response has no children array");

  const roots = children.filter(
    (value): value is Message => value instanceof Message,
  );
  if (roots.length !== children.length)
    throw new TypeError("Reddit returned invalid message data");
  const all: Message[] = [];
  const visit = (message: Message, parent: Message | null): void => {
    if (message.get("parent_id") === parent?.fullname)
      message.setParent(parent);
    all.push(message);
    const replies = message.get<unknown[]>("replies") ?? [];
    for (const reply of replies) {
      if (!(reply instanceof Message))
        throw new TypeError("Reddit returned invalid message reply data");
      visit(reply, message);
    }
  };
  for (const root of roots) visit(root, null);
  return all;
}
