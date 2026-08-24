import { ReadOnlyError } from "../exceptions.js";
import {
  BaseModel,
  isRawData,
  type DataValue,
  type RawData,
  type RedditClientLike,
} from "./base.js";
import { Redditor, Subreddit } from "./entities.js";
import { Message } from "./messages.js";

export interface ModmailClient extends RedditClientLike {
  readonly readOnly: boolean;
}

export interface ModmailActionOptions {
  readonly signal?: AbortSignal;
}

export interface ModmailReplyOptions extends ModmailActionOptions {
  readonly authorHidden?: boolean;
  readonly body: string;
  readonly internal?: boolean;
}

export interface ModmailMuteOptions extends ModmailActionOptions {
  readonly numDays?: 3 | 7 | 28;
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

function id(value: string): string {
  return required(value, "conversation ID").replace(
    /^ModmailConversation_/,
    "",
  );
}

function request(
  client: ModmailClient,
  method: "DELETE" | "POST",
  path: string,
  data: Readonly<Record<string, DataValue>> | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  signal?.throwIfAborted();
  return client.request({
    method,
    path,
    ...(data === undefined ? {} : { data }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function record(value: unknown, name: string): RawData {
  if (!isRawData(value))
    throw new TypeError(`Reddit returned invalid ${name} data`);
  return value;
}

function values(value: unknown): RawData[] {
  if (Array.isArray(value)) return value.map((item) => record(item, "modmail"));
  if (isRawData(value))
    return Object.values(value).map((item) => record(item, "modmail"));
  return [];
}

function author(client: ModmailClient, value: unknown): ModmailAuthor | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string")
    return new ModmailAuthor(client, { name: value });
  return new ModmailAuthor(client, record(value, "modmail author"));
}

export class ModmailAuthor extends Redditor {
  declare isAdmin: unknown;
  declare isDeleted: unknown;
  declare isMod: unknown;

  constructor(client: ModmailClient, data: RawData) {
    super(client, {
      ...data,
      name:
        typeof data["name"] === "string"
          ? data["name"]
          : typeof data["id"] === "string"
            ? data["id"]
            : "[deleted]",
    });
  }
}

export class ModmailUser extends Redditor {
  declare banStatus: unknown;
  declare muteStatus: unknown;
  declare recentComments: unknown;
  declare recentConvos: unknown;
  declare recentPosts: unknown;

  constructor(client: ModmailClient, data: RawData) {
    super(client, {
      ...data,
      name:
        typeof data["name"] === "string"
          ? data["name"]
          : typeof data["user"] === "string"
            ? data["user"]
            : "[deleted]",
    });
  }
}

class ModmailObject extends BaseModel {
  declare author: ModmailAuthor | null;
  declare id: unknown;

  constructor(client: ModmailClient, data: RawData) {
    super(client, { ...data, author: author(client, data["author"]) });
  }

  override toString(): string {
    const value = this.get("id");
    if (typeof value !== "string" || value.length === 0)
      throw new TypeError(`${this.constructor.name} has no valid ID`);
    return value;
  }
}

export class ModmailMessage extends ModmailObject {
  declare bodyMarkdown: unknown;
  declare isInternal: unknown;
}

export class ModmailAction extends ModmailObject {
  declare actionTypeId: unknown;
  declare date: unknown;
}

export interface ModmailConversationData {
  readonly conversation: RawData;
  readonly messages?: readonly ModmailMessage[];
  readonly modActions?: readonly ModmailAction[];
  readonly user?: ModmailUser;
}

export class ModmailConversation extends BaseModel {
  declare authors: readonly ModmailAuthor[];
  declare id: unknown;
  declare messages: readonly ModmailMessage[];
  declare modActions: readonly ModmailAction[];
  declare owner: Subreddit | null;
  declare participant: ModmailUser | null;
  declare user: ModmailUser | undefined;
  readonly #modmailClient: ModmailClient;

  constructor(client: ModmailClient, value: string | ModmailConversationData) {
    const data =
      typeof value === "string" ? { id: id(value) } : value.conversation;
    const ownerData = data["owner"];
    const participantData = data["participant"];
    const authors = Array.isArray(data["authors"])
      ? data["authors"]
          .map((item) => author(client, item))
          .filter((item) => item !== null)
      : [];
    super(client, {
      ...data,
      authors,
      owner:
        isRawData(ownerData) && typeof ownerData["displayName"] === "string"
          ? new Subreddit(client, {
              ...ownerData,
              display_name: ownerData["displayName"],
            })
          : null,
      participant:
        participantData === null || participantData === undefined
          ? null
          : new ModmailUser(
              client,
              record(participantData, "modmail participant"),
            ),
      ...(typeof value === "string"
        ? {}
        : {
            messages: value.messages ?? [],
            modActions: value.modActions ?? [],
            ...(value.user === undefined ? {} : { user: value.user }),
          }),
    });
    this.#modmailClient = client;
  }

  override toString(): string {
    const value = this.get("id");
    if (typeof value !== "string" || value.length === 0)
      throw new TypeError("ModmailConversation has no valid ID");
    return value;
  }

  async refresh(
    options: {
      readonly markRead?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<this> {
    authorized(this.#modmailClient, "modmail conversation refresh");
    options.signal?.throwIfAborted();
    const response = await this.#modmailClient.request({
      method: "GET",
      path: `/api/mod/conversations/${encodeURIComponent(this.toString())}`,
      params: { markRead: options.markRead ?? false },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const parsed = parseModmailConversation(
      this.#modmailClient,
      response,
      this.toString(),
    );
    this.applyData(parsed.raw);
    return this;
  }

  async reply(options: ModmailReplyOptions): Promise<ModmailMessage> {
    authorized(this.#modmailClient, "modmail conversation reply");
    const response = await request(
      this.#modmailClient,
      "POST",
      `/api/mod/conversations/${encodeURIComponent(this.toString())}`,
      {
        body: required(options.body, "body"),
        isAuthorHidden: options.authorHidden ?? false,
        isInternal: options.internal ?? false,
      },
      options.signal,
    );
    const envelope = record(response, "modmail reply");
    const messages = envelope["messages"];
    const conversation = envelope["conversation"];
    if (!isRawData(messages) || !isRawData(conversation))
      throw new TypeError("Reddit returned invalid modmail reply data");
    const objIds = conversation["objIds"];
    const last: unknown = Array.isArray(objIds) ? objIds.at(-1) : undefined;
    const messageId = isRawData(last) ? last["id"] : undefined;
    const message =
      typeof messageId === "string" ? messages[messageId] : undefined;
    return parseModmailMessage(
      this.#modmailClient,
      record(message, "modmail message"),
    );
  }

  archive(options: ModmailActionOptions = {}): Promise<void> {
    return this.simple("POST", "archive", "archive", options);
  }

  unarchive(options: ModmailActionOptions = {}): Promise<void> {
    return this.simple("POST", "unarchive", "unarchive", options);
  }

  highlight(options: ModmailActionOptions = {}): Promise<void> {
    return this.simple("POST", "highlight", "highlight", options);
  }

  unhighlight(options: ModmailActionOptions = {}): Promise<void> {
    return this.simple("DELETE", "highlight", "unhighlight", options);
  }

  async mute(options: ModmailMuteOptions = {}): Promise<void> {
    authorized(this.#modmailClient, "modmail conversation mute");
    const days = options.numDays ?? 3;
    options.signal?.throwIfAborted();
    await this.#modmailClient.request({
      method: "POST",
      path: `/api/mod/conversations/${encodeURIComponent(this.toString())}/mute`,
      ...(days === 3 ? {} : { params: { num_hours: days * 24 } }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  unmute(options: ModmailActionOptions = {}): Promise<void> {
    return this.simple("POST", "unmute", "unmute", options);
  }

  read(
    otherConversations: Iterable<string | ModmailConversation> = [],
    options: ModmailActionOptions = {},
  ): Promise<void> {
    return this.readState("read", otherConversations, options);
  }

  unread(
    otherConversations: Iterable<string | ModmailConversation> = [],
    options: ModmailActionOptions = {},
  ): Promise<void> {
    return this.readState("unread", otherConversations, options);
  }

  private async simple(
    method: "DELETE" | "POST",
    endpoint: string,
    operation: string,
    options: ModmailActionOptions,
  ): Promise<void> {
    authorized(this.#modmailClient, `modmail conversation ${operation}`);
    await request(
      this.#modmailClient,
      method,
      `/api/mod/conversations/${encodeURIComponent(this.toString())}/${endpoint}`,
      undefined,
      options.signal,
    );
  }

  private async readState(
    state: "read" | "unread",
    others: Iterable<string | ModmailConversation>,
    options: ModmailActionOptions,
  ): Promise<void> {
    authorized(this.#modmailClient, `modmail conversation ${state}`);
    const ids = [
      this.toString(),
      ...Array.from(others, (item) => id(String(item))),
    ];
    await request(
      this.#modmailClient,
      "POST",
      `/api/mod/conversations/${state}`,
      { conversationIds: ids.join(",") },
      options.signal,
    );
  }
}

export class LegacyModmailMessage extends Message {
  readonly #modmailClient: ModmailClient;

  constructor(client: ModmailClient, data: RawData) {
    super(client, data);
    this.#modmailClient = client;
  }

  override async reply(
    body: string,
    options: ModmailActionOptions = {},
  ): Promise<LegacyModmailMessage | null> {
    authorized(this.#modmailClient, "legacy modmail reply");
    const response = await request(
      this.#modmailClient,
      "POST",
      "/api/comment",
      { text: required(body, "body"), thing_id: this.fullname },
      options.signal,
    );
    let things: unknown = response;
    if (isRawData(things) && isRawData(things["json"])) things = things["json"];
    if (isRawData(things) && isRawData(things["data"])) things = things["data"];
    if (isRawData(things)) things = things["things"];
    if (!Array.isArray(things) || things.length === 0) return null;
    let item: unknown = things[0];
    if (isRawData(item) && isRawData(item["data"])) item = item["data"];
    return new LegacyModmailMessage(
      this.#modmailClient,
      record(item, "legacy modmail reply"),
    );
  }
}

export function parseModmailMessage(
  client: ModmailClient,
  data: RawData,
): ModmailMessage {
  return new ModmailMessage(client, data);
}

export function parseModmailAction(
  client: ModmailClient,
  data: RawData,
): ModmailAction {
  return new ModmailAction(client, data);
}

export function parseModmailConversation(
  client: ModmailClient,
  value: unknown,
  expectedId?: string,
): ModmailConversation {
  const envelope = record(value, "modmail conversation");
  let conversation: unknown = envelope["conversation"];
  if (conversation === undefined) conversation = envelope["conversations"];
  if (
    isRawData(conversation) &&
    expectedId !== undefined &&
    isRawData(conversation[id(expectedId)])
  )
    conversation = conversation[id(expectedId)];
  if (isRawData(conversation) && typeof conversation["id"] !== "string") {
    const first = Object.values(conversation).find(isRawData);
    if (first !== undefined) conversation = first;
  }
  if (conversation === undefined && typeof envelope["id"] === "string")
    conversation = envelope;
  const data = record(conversation, "modmail conversation");
  const messagesById = envelope["messages"];
  const actionsById = envelope["modActions"];
  const ordered = Array.isArray(data["objIds"]) ? data["objIds"] : [];
  const messages: ModmailMessage[] = [];
  const modActions: ModmailAction[] = [];
  for (const item of ordered) {
    if (!isRawData(item) || typeof item["id"] !== "string") continue;
    if (item["key"] === "messages" && isRawData(messagesById)) {
      const message = messagesById[item["id"]];
      if (isRawData(message))
        messages.push(parseModmailMessage(client, message));
    } else if (item["key"] === "modActions" && isRawData(actionsById)) {
      const action = actionsById[item["id"]];
      if (isRawData(action))
        modActions.push(parseModmailAction(client, action));
    }
  }
  if (messages.length === 0)
    messages.push(
      ...values(messagesById).map((item) => parseModmailMessage(client, item)),
    );
  if (modActions.length === 0)
    modActions.push(
      ...values(actionsById).map((item) => parseModmailAction(client, item)),
    );
  const userData = envelope["user"];
  return new ModmailConversation(client, {
    conversation: data,
    messages,
    modActions,
    ...(isRawData(userData) ? { user: new ModmailUser(client, userData) } : {}),
  });
}
