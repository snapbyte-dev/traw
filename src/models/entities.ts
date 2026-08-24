import {
  BaseModel,
  RedditModel,
  isRawData,
  postRequest,
  type LoadOptions,
  type RawData,
  type RedditClientLike,
  type RedditRequest,
} from "./base.js";
import { CommentForest, type CommentNode } from "./comment-forest.js";
import {
  SubmissionMixin,
  ThingModeration,
  UserContentMixin,
  type ActionOptions,
} from "./mixins.js";
import { InlineMedia, PostMedia, type InlineMediaType } from "./media.js";
import {
  MediaPostFailedError,
  ReadOnlyError,
  RedditApiError,
  WebSocketError,
  type RedditError,
} from "../exceptions.js";
import {
  nodeWebSocketFactory,
  type WebSocketFactory,
  type WebSocketLike,
} from "../core/transport.js";
import { Listing, type ListingOptions } from "../listing.js";
import { Objector } from "../objector.js";
import { MessageBase } from "./message-base.js";

export { MessageBase } from "./message-base.js";

export interface EntityContext {
  readonly comments: Map<string, Comment>;
  readonly moreComments: Map<string, MoreComments>;
  readonly redditors: Map<string, Redditor>;
  readonly submissions: Map<string, Submission>;
  readonly subreddits: Map<string, Subreddit>;
  submission?: Submission;
}

export function createEntityContext(submission?: Submission): EntityContext {
  return {
    comments: new Map(),
    moreComments: new Map(),
    redditors: new Map(),
    submissions: new Map(),
    subreddits: new Map(),
    ...(submission === undefined ? {} : { submission }),
  };
}

export class Comment extends UserContentMixin {
  readonly kind = "t1";
  declare author: unknown;
  declare body: unknown;
  declare parent_id: unknown;
  declare replies: unknown;
  declare subreddit: unknown;
  #context: EntityContext;
  #moderation: CommentModeration | undefined;

  constructor(
    client: RedditClientLike,
    value: string | RawData,
    context?: EntityContext,
  ) {
    super(client, "t1", value);
    this.#context = context ?? createEntityContext();
    if (typeof value !== "string") {
      const entityContext = this.#context;
      entityContext.comments.set(this.fullname.toLowerCase(), this);
      this.applyObjectifiedData(value, entityContext);
    }
  }

  applyObjectifiedData(data: RawData, context: EntityContext): void {
    this.#context = context;
    this.applyData(objectifyEntityFields(this.client, data, context));
  }

  get isRoot(): boolean {
    const parentId = this.get("parent_id");
    if (typeof parentId !== "string")
      throw new TypeError("Comment has no valid parent_id");
    return parentId.startsWith("t3_");
  }

  override get mod(): CommentModeration {
    return (this.#moderation ??= new CommentModeration(this));
  }

  parent(): Comment | Submission {
    const parentId = this.get("parent_id");
    if (typeof parentId !== "string" || !/^t[13]_/.test(parentId))
      throw new TypeError("Comment has no valid parent_id");
    if (parentId.startsWith("t1_")) {
      this.#context.submission ??= this.commentSubmission();
      return (
        this.#context.comments.get(parentId.toLowerCase()) ??
        new Comment(this.client, parentId, this.#context)
      );
    }
    const submission = this.commentSubmission(parentId);
    this.#context.submission ??= submission;
    return submission;
  }

  private commentSubmission(parentId?: string): Submission {
    const attached = (this as Comment & { submission?: unknown }).submission;
    if (attached instanceof Submission) return attached;
    if (this.#context.submission !== undefined) return this.#context.submission;
    const linkId = this.get("link_id");
    const fullname =
      typeof linkId === "string" && linkId.startsWith("t3_")
        ? linkId
        : parentId?.startsWith("t3_") === true
          ? parentId
          : undefined;
    if (fullname === undefined)
      throw new TypeError("Comment has no valid submission reference");
    return objectifySubmission(
      this.client,
      { id: fullname.slice(3), name: fullname },
      this.#context,
    );
  }

  protected createReply(data: RawData): Comment {
    return new Comment(this.client, data);
  }
}

export class CommentModeration extends ThingModeration<Comment> {
  show(options: ActionOptions = {}): Promise<unknown> {
    assertThingModeratorAccess(this.thing, "comment.mod.show()");
    return postRequest(
      this.thing.client,
      "/api/show_comment",
      { id: this.thing.fullname },
      options.signal,
    );
  }

  sendRemovalMessage(
    message: string,
    options: RemovalMessageOptions = {},
  ): Promise<Comment | null> {
    return sendRemovalMessage(
      this.thing,
      "/api/v1/modactions/removal_comment_message",
      message,
      options,
    );
  }
}

export class Submission extends SubmissionMixin {
  readonly kind = "t3";
  declare author: unknown;
  declare selftext: unknown;
  declare subreddit: unknown;
  declare title: unknown;
  comments: CommentForest | undefined;
  #flair: SubmissionFlair | undefined;
  #moderation: SubmissionModeration | undefined;
  #commentLimit = 2048;
  #commentSort = "confidence";

  constructor(
    client: RedditClientLike,
    value: string | RawData,
    context?: EntityContext,
  ) {
    super(client, "t3", value);
    if (typeof value !== "string") {
      const entityContext = context ?? createEntityContext(this);
      entityContext.submission ??= this;
      entityContext.submissions.set(this.fullname.toLowerCase(), this);
      this.applyObjectifiedData(value, entityContext);
    }
  }

  get commentLimit(): number {
    return this.#commentLimit;
  }

  set commentLimit(value: number) {
    this.guardCommentOption("commentLimit");
    this.#commentLimit = value;
  }

  get commentSort(): string {
    return this.#commentSort;
  }

  set commentSort(value: string) {
    this.guardCommentOption("commentSort");
    this.#commentSort = value;
  }

  get flair(): SubmissionFlair {
    return (this.#flair ??= new SubmissionFlair(this));
  }

  override get mod(): SubmissionModeration {
    return (this.#moderation ??= new SubmissionModeration(this));
  }

  override async refresh(options: LoadOptions = {}): Promise<this> {
    options.signal?.throwIfAborted();
    const response = await this.client.request({
      method: "GET",
      path: `/comments/${encodeURIComponent(this.toString())}/`,
      params: { limit: this.commentLimit, sort: this.commentSort },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const [submissionData, comments, context] = parseSubmissionListings(
      this.client,
      response,
      this,
    );
    this.applyObjectifiedData(submissionData, context);
    this.comments = new CommentForest(this, comments);
    this.applyLoadedData({ comments: this.comments });
    return this;
  }

  applyObjectifiedData(data: RawData, context: EntityContext): void {
    this.applyData(objectifyEntityFields(this.client, data, context));
  }

  duplicates(options: ListingOptions = {}): Listing<Submission> {
    return new Listing<Submission>(
      this.client,
      `/duplicates/${encodeURIComponent(this.toString())}/`,
      options,
    );
  }

  override async edit(
    body: string,
    options: SubmissionEditOptions = {},
  ): Promise<this> {
    if (options.inlineMedia === undefined) return super.edit(body, options);
    const richtextJson = await inlineRichText(
      this.client,
      body,
      options.inlineMedia,
      options.signal,
    );
    const response = await postRequest(
      this.client,
      "/api/editusertext",
      {
        richtext_json: richtextJson,
        thing_id: this.fullname,
        validate_on_submit: true,
      },
      options.signal,
    );
    return this.applyEditResponse(response);
  }

  async crosspost(
    subreddit: string | Subreddit,
    options: CrosspostOptions = {},
  ): Promise<Submission> {
    options.signal?.throwIfAborted();
    let title = options.title;
    if (title === undefined) {
      const current = this.get("title");
      if (typeof current !== "string") await this.load(options);
      const loaded = this.get("title");
      if (typeof loaded !== "string")
        throw new TypeError("Submission has no title for crosspost");
      title = loaded;
    }
    const response = await postRequest(
      this.client,
      "/api/submit/",
      {
        crosspost_fullname: this.fullname,
        kind: "crosspost",
        nsfw: options.nsfw ?? false,
        sendreplies: options.sendReplies ?? true,
        spoiler: options.spoiler ?? false,
        sr: subreddit.toString(),
        title,
        ...(options.flairId === undefined ? {} : { flair_id: options.flairId }),
        ...(options.flairText === undefined
          ? {}
          : { flair_text: options.flairText }),
      },
      options.signal,
    );
    const created = findModel(
      new Objector(this.client).objectify(response),
      Submission,
    );
    if (created === undefined)
      throw new TypeError("Reddit response did not contain crosspost data");
    return created;
  }

  markVisited(options: ActionOptions = {}): Promise<unknown> {
    return postRequest(
      this.client,
      "/api/store_visits",
      { links: this.fullname },
      options.signal,
    );
  }

  private guardCommentOption(option: "commentLimit" | "commentSort"): void {
    if (this.isLoaded)
      throw new TypeError(
        `Cannot update ${option} after this submission has been loaded`,
      );
  }

  protected createReply(data: RawData): Comment {
    return new Comment(this.client, data);
  }
}

export interface CrosspostOptions extends ActionOptions {
  readonly flairId?: string;
  readonly flairText?: string;
  readonly nsfw?: boolean;
  readonly sendReplies?: boolean;
  readonly spoiler?: boolean;
  readonly title?: string;
}

export interface SubmissionEditOptions extends ActionOptions {
  readonly inlineMedia?: Readonly<Record<string, InlineMedia>>;
}

export interface FlairChoice {
  readonly flairCssClass?: string;
  readonly flairTemplateId: string;
  readonly flairText?: string;
  readonly flairTextEditable?: boolean;
  readonly [field: string]: unknown;
}

export interface FlairSelectOptions extends ActionOptions {
  readonly text?: string;
}

export class SubmissionFlair {
  readonly submission: Submission;

  constructor(submission: Submission) {
    this.submission = submission;
  }

  async choices(options: ActionOptions = {}): Promise<readonly FlairChoice[]> {
    const subreddit = await submissionSubreddit(this.submission, options);
    const response = await postRequest(
      this.submission.client,
      `/r/${encodeURIComponent(subreddit)}/api/flairselector/`,
      { link: this.submission.fullname },
      options.signal,
    );
    if (!isRawData(response) || !Array.isArray(response["choices"]))
      throw new TypeError("Reddit flair response has no choices array");
    return response["choices"].map(flairChoice);
  }

  async select(
    flairTemplateId: string,
    options: FlairSelectOptions = {},
  ): Promise<unknown> {
    if (flairTemplateId.trim().length === 0)
      throw new TypeError("flairTemplateId cannot be empty");
    const subreddit = await submissionSubreddit(this.submission, options);
    return postRequest(
      this.submission.client,
      `/r/${encodeURIComponent(subreddit)}/api/selectflair/`,
      {
        flair_template_id: flairTemplateId,
        link: this.submission.fullname,
        ...(options.text === undefined ? {} : { text: options.text }),
      },
      options.signal,
    );
  }
}

export type SuggestedSort =
  | "blank"
  | "confidence"
  | "controversial"
  | "new"
  | "old"
  | "qa"
  | "random"
  | "top";

export interface StateOptions extends ActionOptions {
  readonly state?: boolean;
}

export interface StickyOptions extends StateOptions {
  readonly bottom?: boolean;
}

export interface SuggestedSortOptions extends ActionOptions {
  readonly sort?: SuggestedSort;
}

export type RemovalMessageType =
  "private" | "private_exposed" | "public" | "public_as_subreddit";

export interface RemovalMessageOptions extends ActionOptions {
  readonly title?: string;
  readonly type?: RemovalMessageType;
}

export class SubmissionModeration extends ThingModeration<Submission> {
  sendRemovalMessage(
    message: string,
    options: RemovalMessageOptions = {},
  ): Promise<Comment | null> {
    return sendRemovalMessage(
      this.thing,
      "/api/v1/modactions/removal_link_message",
      message,
      options,
    );
  }

  contestMode(options: StateOptions = {}): Promise<unknown> {
    return this.stateAction("/api/set_contest_mode/", options);
  }

  nsfw(options: ActionOptions = {}): Promise<unknown> {
    return this.action("/api/marknsfw/", options);
  }

  sfw(options: ActionOptions = {}): Promise<unknown> {
    return this.action("/api/unmarknsfw/", options);
  }

  spoiler(options: ActionOptions = {}): Promise<unknown> {
    return this.action("/api/spoiler/", options);
  }

  unspoiler(options: ActionOptions = {}): Promise<unknown> {
    return this.action("/api/unspoiler/", options);
  }

  sticky(options: StickyOptions = {}): Promise<unknown> {
    return postRequest(
      this.thing.client,
      "/api/set_subreddit_sticky/",
      {
        id: this.thing.fullname,
        state: options.state ?? true,
        ...(options.bottom === false ? { num: 1 } : {}),
      },
      options.signal,
    );
  }

  suggestedSort(options?: SuggestedSortOptions): Promise<unknown>;
  suggestedSort(
    sort?: SuggestedSort,
    options?: ActionOptions,
  ): Promise<unknown>;
  suggestedSort(
    sortOrOptions: SuggestedSort | SuggestedSortOptions = "blank",
    actionOptions: ActionOptions = {},
  ): Promise<unknown> {
    const sort =
      typeof sortOrOptions === "string"
        ? sortOrOptions
        : (sortOrOptions.sort ?? "blank");
    const options =
      typeof sortOrOptions === "string" ? actionOptions : sortOrOptions;
    if (
      ![
        "blank",
        "confidence",
        "controversial",
        "new",
        "old",
        "qa",
        "random",
        "top",
      ].includes(sort)
    )
      throw new RangeError(`Invalid suggested sort: ${sort}`);
    return postRequest(
      this.thing.client,
      "/api/set_suggested_sort/",
      { id: this.thing.fullname, sort },
      options.signal,
    );
  }

  updateCrowdControlLevel(
    level: 0 | 1 | 2 | 3,
    options: ActionOptions = {},
  ): Promise<unknown> {
    if (!Number.isInteger(level) || level < 0 || level > 3)
      throw new RangeError(
        "crowd control level must be an integer from 0 to 3",
      );
    return postRequest(
      this.thing.client,
      "/api/update_crowd_control_level",
      { id: this.thing.fullname, level },
      options.signal,
    );
  }

  setOriginalContent(options: ActionOptions = {}): Promise<unknown> {
    return this.originalContent(true, options);
  }

  unsetOriginalContent(options: ActionOptions = {}): Promise<unknown> {
    return this.originalContent(false, options);
  }

  private stateAction(path: string, options: StateOptions): Promise<unknown> {
    return postRequest(
      this.thing.client,
      path,
      { id: this.thing.fullname, state: options.state ?? true },
      options.signal,
    );
  }

  private async originalContent(
    state: boolean,
    options: ActionOptions,
  ): Promise<unknown> {
    const subreddit = await submissionSubreddit(this.thing, options);
    return postRequest(
      this.thing.client,
      "/api/set_original_content",
      {
        executed: false,
        fullname: this.thing.fullname,
        id: this.thing.toString(),
        r: subreddit,
        should_set_oc: state,
      },
      options.signal,
    );
  }
}

function assertThingModeratorAccess(
  thing: UserContentMixin,
  operation: string,
): void {
  if (
    (thing.client as RedditClientLike & { readonly readOnly?: boolean })
      .readOnly
  ) {
    throw new ReadOnlyError(`${operation} does not work in read-only mode`);
  }
}

async function sendRemovalMessage(
  thing: UserContentMixin,
  path: string,
  message: string,
  options: RemovalMessageOptions,
): Promise<Comment | null> {
  assertThingModeratorAccess(thing, "mod.sendRemovalMessage()");
  if (message.trim().length === 0)
    throw new TypeError("removal message cannot be empty");
  const type = options.type ?? "public";
  if (
    !["private", "private_exposed", "public", "public_as_subreddit"].includes(
      type,
    )
  ) {
    throw new RangeError(`Invalid removal message type: ${type}`);
  }
  const response = await postRequest(
    thing.client,
    path,
    {
      json: JSON.stringify({
        item_id: [thing.fullname],
        message,
        title: options.title ?? "ignored",
        type,
      }),
    },
    options.signal,
  );
  if (response == null) return null;
  const comment = findModel(
    new Objector(thing.client).objectify(response),
    Comment,
  );
  if (comment === undefined)
    throw new TypeError(
      "Reddit response did not contain removal message Comment data",
    );
  return comment;
}

async function submissionSubreddit(
  submission: Submission,
  options: ActionOptions,
): Promise<string> {
  let value = submission.get("subreddit");
  if (!(value instanceof Subreddit) && typeof value !== "string") {
    await submission.load(options);
    value = submission.get("subreddit");
  }
  if (value instanceof Subreddit) return value.toString();
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError("Submission has no subreddit");
}

function flairChoice(value: unknown): FlairChoice {
  if (!isRawData(value) || typeof value["flair_template_id"] !== "string")
    throw new TypeError("Reddit flair response contains an invalid choice");
  return {
    ...value,
    flairTemplateId: value["flair_template_id"],
    ...(typeof value["flair_css_class"] === "string"
      ? { flairCssClass: value["flair_css_class"] }
      : {}),
    ...(typeof value["flair_text"] === "string"
      ? { flairText: value["flair_text"] }
      : {}),
    ...(typeof value["flair_text_editable"] === "boolean"
      ? { flairTextEditable: value["flair_text_editable"] }
      : {}),
  };
}

function findModel<T>(
  value: unknown,
  constructor: abstract new (...args: never[]) => T,
): T | undefined {
  if (value instanceof constructor) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findModel(item, constructor);
      if (found !== undefined) return found;
    }
  } else if (isRawData(value)) {
    for (const item of Object.values(value)) {
      const found = findModel(item, constructor);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export class Redditor extends RedditModel {
  readonly kind = "t2";
  readonly identityField = "name";
  declare comment_karma: unknown;
  declare link_karma: unknown;
  declare subreddit: UserSubreddit | null | undefined;

  constructor(client: RedditClientLike, value: string | RawData) {
    super(client, "name", value);
    if (typeof value !== "string") this.applyObjectifiedData(value);
  }

  applyObjectifiedData(data: RawData): void {
    this.applyData(objectifyRedditorFields(this.client, data));
  }

  get fullname(): string | undefined {
    const value = this.get("id");
    return typeof value === "string" ? `t2_${value}` : undefined;
  }

  message(
    subject: string,
    body: string,
    options: ActionOptions = {},
  ): Promise<unknown> {
    return postRequest(
      this.client,
      "/api/compose",
      { subject, text: body, to: this.toString() },
      options.signal,
    );
  }

  protected fetchRequest(): Pick<RedditRequest, "path"> {
    return { path: `/user/${encodeURIComponent(this.toString())}/about` };
  }

  protected override applyLoadedData(data: RawData): void {
    super.applyLoadedData(objectifyRedditorFields(this.client, data));
  }
}

const INLINE_PLACEHOLDER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function expectedInlineMime(type: InlineMediaType, mimeType: string): boolean {
  if (type === "gif") return mimeType === "image/gif";
  if (type === "img")
    return mimeType.startsWith("image/") && mimeType !== "image/gif";
  return mimeType.startsWith("video/");
}

async function inlineRichText(
  client: RedditClientLike,
  body: string,
  inlineMedia: Readonly<Record<string, InlineMedia>>,
  signal?: AbortSignal,
): Promise<string> {
  const entries = Object.entries(inlineMedia);
  if (entries.length === 0)
    throw new TypeError("inlineMedia must contain at least one placeholder");
  for (const [key, media] of entries) {
    if (!INLINE_PLACEHOLDER.test(key))
      throw new TypeError(`Invalid inline media placeholder key: ${key}`);
    if (!body.includes(`{${key}}`))
      throw new TypeError(
        `Inline media placeholder {${key}} is missing from body`,
      );
    if (!(media instanceof InlineMedia))
      throw new TypeError(
        `Inline media placeholder {${key}} is not InlineMedia`,
      );
    if (!expectedInlineMime(media.type, media.media.mimeType))
      throw new TypeError(
        `Inline media placeholder {${key}} has the wrong media type`,
      );
  }

  let rendered = body;
  for (const [key, media] of entries) {
    media.mediaId = await media.media.upload(client, {
      uploadType: "selfpost",
      ...(signal === undefined ? {} : { signal }),
    });
    rendered = rendered.replaceAll(`{${key}}`, media.toString());
  }
  const converted = await postRequest(
    client,
    "/api/convert_rte_body_format",
    { markdown_text: rendered, output_mode: "rtjson" },
    signal,
  );
  if (!isRawData(converted) || converted["output"] === undefined)
    throw new TypeError(
      "Reddit rich-text conversion response is missing output",
    );
  const serialized = JSON.stringify(converted["output"]);
  return serialized;
}

function webSocketUrl(response: unknown): string | undefined {
  if (!isRawData(response)) return undefined;
  const json = response["json"];
  const data = isRawData(json) ? json["data"] : response["data"];
  const value = isRawData(data) ? data["websocket_url"] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventData(event: unknown): unknown {
  return isRawData(event) && "data" in event ? event["data"] : event;
}

function receiveWebSocket(
  url: string,
  factory: WebSocketFactory,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let socket: WebSocketLike;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeEventListener("close", close);
      socket.removeEventListener("error", error);
      socket.removeEventListener("message", message);
      socket.close();
    };
    const fail = (value: Error): void => {
      cleanup();
      reject(value);
    };
    const abort = (): void => {
      fail(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError"),
      );
    };
    const close = (): void => {
      fail(
        new WebSocketError(
          "WebSocket closed before media processing completed",
        ),
      );
    };
    const error = (): void => {
      fail(new WebSocketError("WebSocket media processing connection failed"));
    };
    const message = (event: unknown): void => {
      const data = eventData(event);
      cleanup();
      resolve(data);
    };
    try {
      socket = factory(url);
    } catch {
      reject(new WebSocketError("Unable to establish WebSocket connection"));
      return;
    }
    const timer = setTimeout(
      () =>
        fail(
          new WebSocketError(
            `WebSocket media processing timed out after ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    socket.addEventListener("close", close);
    socket.addEventListener("error", error);
    socket.addEventListener("message", message);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function parseWebSocketUpdate(value: unknown): Promise<string> {
  let decoded = value;
  if (typeof Blob !== "undefined" && value instanceof Blob)
    decoded = await value.text();
  if (value instanceof ArrayBuffer)
    decoded = new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value))
    decoded = new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      throw new WebSocketError(
        "WebSocket returned invalid media processing JSON",
      );
    }
  }
  if (!isRawData(decoded))
    throw new WebSocketError(
      "WebSocket returned an invalid media processing update",
    );
  if (decoded["type"] === "failed") throw new MediaPostFailedError();
  const payload = decoded["payload"];
  if (!isRawData(payload) || typeof payload["redirect"] !== "string")
    throw new WebSocketError(
      "WebSocket update is missing a media post redirect",
    );
  return payload["redirect"];
}

function submissionFromRedirect(
  client: RedditClientLike,
  redirect: string,
): Submission {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    throw new WebSocketError(
      "WebSocket returned an invalid media post redirect",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const comments = parts.indexOf("comments");
  const id = comments >= 0 ? parts[comments + 1] : parts[0];
  if (id === undefined || id.length === 0)
    throw new WebSocketError("WebSocket redirect has no submission ID");
  return new Submission(client, id);
}

async function completeMediaSubmission(
  client: RedditClientLike,
  response: unknown,
  options: MediaProcessingOptions,
): Promise<unknown> {
  if (options.withoutWebSockets === true) return response;
  const url = webSocketUrl(response);
  if (url === undefined) return response;
  const update = await receiveWebSocket(
    url,
    options.webSocketFactory ?? client.webSocketFactory ?? nodeWebSocketFactory,
    options.timeoutMs ?? 10_000,
    options.signal,
  );
  return submissionFromRedirect(client, await parseWebSocketUpdate(update));
}

export class Subreddit extends RedditModel {
  readonly kind = "t5";
  readonly identityField = "display_name";
  declare subscribers: unknown;

  constructor(client: RedditClientLike, value: string | RawData) {
    super(client, "display_name", value);
  }

  applyObjectifiedData(data: RawData): void {
    this.applyData(data);
  }

  get fullname(): string | undefined {
    const name = this.get("name");
    if (typeof name === "string" && name.startsWith("t5_")) return name;
    const id = this.get("id");
    return typeof id === "string" ? `t5_${id}` : undefined;
  }

  subscribe(options: ActionOptions = {}): Promise<unknown> {
    return this.subscriptionRequest("sub", options);
  }

  unsubscribe(options: ActionOptions = {}): Promise<unknown> {
    return this.subscriptionRequest("unsub", options);
  }

  submit(title: string, options: SubmitOptions): Promise<unknown> {
    validateSubmitOptions(options);
    options.signal?.throwIfAborted();
    return this.submitValidated(title, options);
  }

  private async submitValidated(
    title: string,
    options: SubmitOptions,
  ): Promise<unknown> {
    const common = {
      nsfw: options.nsfw ?? false,
      sendreplies: options.sendReplies ?? true,
      spoiler: options.spoiler ?? false,
      sr: this.toString(),
      title,
      validate_on_submit: true,
    };
    if (options.kind === "poll") {
      const json = {
        ...common,
        duration: options.duration,
        options: [...options.options],
        resubmit: options.resubmit ?? true,
        text: options.selftext ?? "",
      };
      if (this.client.post !== undefined)
        return this.client.post("/api/submit_poll_post", {
          json,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      return this.client.request({
        json,
        method: "POST",
        path: "/api/submit_poll_post",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    if (options.kind === "gallery") {
      const items = [];
      for (const item of options.items) {
        items.push({
          caption: item.caption ?? "",
          media_id: await item.media.upload(this.client, {
            expectedMimePrefix: "image",
            uploadType: "gallery",
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
          outbound_url: item.outboundUrl ?? "",
        });
      }
      const response = await this.client.request({
        json: {
          ...common,
          items,
          show_error_list: true,
          ...(options.selftext === undefined ? {} : { text: options.selftext }),
        },
        method: "POST",
        path: "/api/submit_gallery_post.json",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (isRawData(response) && isRawData(response["json"])) {
        const errors = response["json"]["errors"];
        if (Array.isArray(errors) && errors.length > 0)
          throw new RedditApiError(errors as readonly RedditError[]);
      }
      return response;
    }

    const data: Record<string, boolean | number | string | readonly string[]> =
      {
        ...common,
        kind: options.kind === "text" ? "self" : options.kind,
        resubmit: options.resubmit ?? true,
      };
    if (options.kind === "text") data["text"] = options.selftext;
    if (options.kind === "text" && options.inlineMedia !== undefined) {
      delete data["text"];
      data["richtext_json"] = await inlineRichText(
        this.client,
        options.selftext,
        options.inlineMedia,
        options.signal,
      );
    }
    if (options.kind === "link") {
      data["url"] = options.url;
      if (options.selftext) data["text"] = options.selftext;
    }
    if (options.kind === "image") {
      data["url"] = await options.image.upload(this.client, {
        expectedMimePrefix: "image",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (options.selftext !== undefined) data["text"] = options.selftext;
    }
    if (options.kind === "video") {
      data["url"] = await options.video.upload(this.client, {
        expectedMimePrefix: "video",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (options.thumbnail !== undefined)
        data["video_poster_url"] = await options.thumbnail.upload(this.client, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      if (options.selftext !== undefined) data["text"] = options.selftext;
      if (options.gif === true) data["kind"] = "videogif";
    }
    const response = await postRequest(
      this.client,
      "/api/submit",
      data,
      options.signal,
    );
    return options.kind === "image" || options.kind === "video"
      ? completeMediaSubmission(this.client, response, options)
      : response;
  }

  private subscriptionRequest(
    action: "sub" | "unsub",
    options: ActionOptions,
  ): Promise<unknown> {
    return postRequest(
      this.client,
      "/api/subscribe",
      {
        action,
        sr_name: this.toString(),
        ...(action === "sub" ? { skip_inital_defaults: true } : {}),
      },
      options.signal,
    );
  }

  protected fetchRequest(): Pick<RedditRequest, "path"> {
    return { path: `/r/${encodeURIComponent(this.toString())}/about` };
  }
}

/** A profile subreddit embedded in a Redditor response. */
export class UserSubreddit extends Subreddit {}

function objectifyRedditorFields(
  client: RedditClientLike,
  data: RawData,
): RawData {
  const subreddit = data["subreddit"];
  if (subreddit === undefined || subreddit === null) return data;
  if (subreddit instanceof UserSubreddit) return data;
  if (
    !isRawData(subreddit) ||
    typeof subreddit["display_name"] !== "string" ||
    subreddit["display_name"].length === 0
  ) {
    throw new TypeError("Reddit returned invalid user subreddit data");
  }
  return { ...data, subreddit: new UserSubreddit(client, subreddit) };
}

export class MoreComments extends BaseModel {
  readonly kind = "more";
  #comments: CommentNode[] | undefined;
  #pending: Promise<CommentNode[]> | undefined;

  get identity(): string {
    const children = this.get<unknown[]>("children") ?? [];
    const count = this.get<number>("count") ?? 0;
    return `more:${count}:${children.join(",")}`;
  }

  equals(other: unknown): boolean {
    return other instanceof MoreComments && this.identity === other.identity;
  }

  async comments(submission: Submission): Promise<(Comment | MoreComments)[]> {
    if (this.#comments !== undefined) return this.#comments;
    if (this.#pending !== undefined) return this.#pending;
    const children = this.get<unknown[]>("children") ?? [];
    if (
      !children.every((child): child is string => typeof child === "string")
    ) {
      throw new TypeError("MoreComments children must be strings");
    }
    this.#pending = this.fetchComments(submission, children);
    try {
      this.#comments = await this.#pending;
      return this.#comments;
    } finally {
      this.#pending = undefined;
    }
  }

  private async fetchComments(
    submission: Submission,
    children: string[],
  ): Promise<CommentNode[]> {
    if ((this.get<number>("count") ?? 0) === 0 && children.length === 0) {
      const parentId = this.get("parent_id");
      if (typeof parentId !== "string" || !parentId.startsWith("t1_"))
        throw new TypeError("continuation MoreComments has no comment parent");
      const response = await this.client.request({
        method: "GET",
        path: `/comments/${encodeURIComponent(submission.toString())}/_/${encodeURIComponent(parentId.slice(3))}`,
        params: {
          limit: submission.commentLimit,
          sort: submission.commentSort,
        },
      });
      const comments = parseCommentListing(this.client, response, submission);
      if (comments.length !== 1 || !(comments[0] instanceof Comment))
        throw new TypeError("continuation response did not contain its parent");
      if (!(comments[0].replies instanceof CommentForest))
        throw new TypeError("continuation parent has no reply forest");
      return [...comments[0].replies];
    }
    if (children.length === 0)
      throw new TypeError("MoreComments has no children to expand");

    const response = await this.client.request({
      method: "POST",
      path: "/api/morechildren",
      data: {
        children: children.join(","),
        link_id: submission.fullname,
        sort: submission.commentSort,
      },
    });
    const comments = parseMoreChildren(this.client, response, submission);
    return [...new CommentForest(submission, comments)];
  }
}

interface CommonSubmitOptions {
  readonly nsfw?: boolean;
  readonly resubmit?: boolean;
  readonly sendReplies?: boolean;
  readonly signal?: AbortSignal;
  readonly spoiler?: boolean;
}

interface MediaProcessingOptions extends ActionOptions {
  readonly timeoutMs?: number;
  readonly webSocketFactory?: WebSocketFactory;
  readonly withoutWebSockets?: boolean;
}

export type SubmitOptions = CommonSubmitOptions &
  (
    | {
        readonly inlineMedia?: Readonly<Record<string, InlineMedia>>;
        readonly kind: "text";
        readonly selftext: string;
      }
    | {
        readonly kind: "link";
        readonly selftext?: string;
        readonly url: string;
      }
    | {
        readonly duration: number;
        readonly kind: "poll";
        readonly options: readonly string[];
        readonly selftext?: string;
      }
    | (MediaProcessingOptions & {
        readonly image: PostMedia;
        readonly kind: "image";
        readonly selftext?: string;
      })
    | (MediaProcessingOptions & {
        readonly gif?: boolean;
        readonly kind: "video";
        readonly selftext?: string;
        readonly thumbnail?: PostMedia;
        readonly video: PostMedia;
      })
    | {
        readonly items: readonly GalleryItem[];
        readonly kind: "gallery";
        readonly selftext?: string;
      }
  );

export interface GalleryItem {
  readonly caption?: string;
  readonly media: PostMedia;
  readonly outboundUrl?: string;
}

function validateSubmitOptions(options: SubmitOptions): void {
  if (
    (options.kind === "image" || options.kind === "video") &&
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  )
    throw new RangeError("timeoutMs must be a non-negative finite number");
  if (options.kind === "poll") {
    if (
      !Number.isInteger(options.duration) ||
      options.duration < 1 ||
      options.duration > 7
    )
      throw new RangeError("poll duration must be an integer from 1 through 7");
    if (options.options.length < 2 || options.options.length > 6)
      throw new RangeError("poll options must contain between 2 and 6 entries");
    if (options.options.some((option) => option.length === 0))
      throw new TypeError("poll options cannot be empty");
  }
  if (options.kind === "image" && !options.image.mimeType.startsWith("image/"))
    throw new TypeError("image media must have an image MIME type");
  if (options.kind === "video" && !options.video.mimeType.startsWith("video/"))
    throw new TypeError("video media must have a video MIME type");
  if (options.kind === "gallery") {
    if (options.items.length === 0)
      throw new TypeError("gallery cannot be empty");
    for (const item of options.items) {
      if (!item.media.mimeType.startsWith("image/"))
        throw new TypeError("gallery media must have an image MIME type");
      if ((item.caption?.length ?? 0) > 180)
        throw new RangeError("gallery captions must be 180 characters or less");
    }
  }
}

function parseMoreChildren(
  client: RedditClientLike,
  response: unknown,
  submission: Submission,
): (Comment | MoreComments)[] {
  let things: unknown = response;
  if (isRawData(things) && isRawData(things["json"])) things = things["json"];
  if (isRawData(things) && isRawData(things["data"])) things = things["data"];
  if (isRawData(things) && Array.isArray(things["things"]))
    things = things["things"];
  if (!Array.isArray(things))
    throw new TypeError("morechildren response has no things array");
  const context = createEntityContext(submission);
  return things.map((thing) => {
    if (!isRawData(thing) || !isRawData(thing["data"]))
      throw new TypeError("morechildren response contains an invalid thing");
    if (thing["kind"] === "t1")
      return objectifyComment(client, thing["data"], context);
    if (thing["kind"] === "more")
      return objectifyMoreComments(client, thing["data"], context);
    throw new TypeError("morechildren response contains an unsupported thing");
  });
}

export function objectifyComment(
  client: RedditClientLike,
  data: RawData,
  context: EntityContext = createEntityContext(),
): Comment {
  const key = fullnameKey("t1", data);
  const existing = key === undefined ? undefined : context.comments.get(key);
  if (existing !== undefined) {
    existing.applyObjectifiedData(data, context);
    return existing;
  }
  return new Comment(client, data, context);
}

export function objectifyMoreComments(
  client: RedditClientLike,
  data: RawData,
  context: EntityContext = createEntityContext(),
): MoreComments {
  const key = moreKey(data);
  const existing = context.moreComments.get(key);
  if (existing !== undefined) return existing;
  const more = new MoreComments(client, data);
  context.moreComments.set(key, more);
  return more;
}

export function objectifyRedditor(
  client: RedditClientLike,
  data: RawData,
  context: EntityContext = createEntityContext(),
): Redditor {
  const name = data["name"];
  if (typeof name !== "string") return new Redditor(client, data);
  const key = name.toLowerCase();
  const existing = context.redditors.get(key);
  if (existing !== undefined) {
    existing.applyObjectifiedData(data);
    return existing;
  }
  const redditor = new Redditor(client, data);
  context.redditors.set(key, redditor);
  return redditor;
}

export function objectifySubmission(
  client: RedditClientLike,
  data: RawData,
  context: EntityContext = createEntityContext(),
): Submission {
  const key = fullnameKey("t3", data);
  const existing =
    key === undefined
      ? undefined
      : (context.submissions.get(key) ??
        (context.submission?.fullname.toLowerCase() === key
          ? context.submission
          : undefined));
  if (existing !== undefined) {
    context.submissions.set(existing.fullname.toLowerCase(), existing);
    existing.applyObjectifiedData(data, context);
    return existing;
  }
  return new Submission(client, data, context);
}

export function objectifySubreddit(
  client: RedditClientLike,
  data: RawData,
  context: EntityContext = createEntityContext(),
): Subreddit {
  const name = data["display_name"];
  if (typeof name !== "string") return new Subreddit(client, data);
  const key = name.toLowerCase();
  const existing = context.subreddits.get(key);
  if (existing !== undefined) {
    existing.applyObjectifiedData(data);
    return existing;
  }
  const subreddit = new Subreddit(client, data);
  context.subreddits.set(key, subreddit);
  return subreddit;
}

function objectifyEntityFields(
  client: RedditClientLike,
  data: RawData,
  context: EntityContext,
): RawData {
  const result = { ...data };
  const author = data["author"];
  if (typeof author === "string")
    result["author"] = objectifyRedditor(client, { name: author }, context);
  else if (isRawData(author))
    result["author"] = objectifyRedditor(client, author, context);

  const subreddit = data["subreddit"];
  if (typeof subreddit === "string")
    result["subreddit"] = objectifySubreddit(
      client,
      { display_name: subreddit },
      context,
    );
  else if (isRawData(subreddit))
    result["subreddit"] = objectifySubreddit(client, subreddit, context);

  if ("replies" in data) {
    if (data["replies"] instanceof CommentForest) return result;
    const replies = data["replies"];
    const children = Array.isArray(replies)
      ? replies.filter(
          (thing) =>
            thing instanceof Comment ||
            thing instanceof MoreComments ||
            (isRawData(thing) && isRawData(thing["data"])),
        )
      : listingChildren(replies);
    if (Array.isArray(replies) && children.length === 0) return result;
    result["replies"] = new CommentForest(
      context.submission ?? submissionFromComment(client, data, context),
      children.map((thing) => objectifyCommentThing(client, thing, context)),
    );
  }
  return result;
}

function submissionFromComment(
  client: RedditClientLike,
  data: RawData,
  context: EntityContext,
): Submission {
  const linkId = data["link_id"];
  const parentId = data["parent_id"];
  const fullname =
    typeof linkId === "string" && linkId.startsWith("t3_")
      ? linkId
      : typeof parentId === "string" && parentId.startsWith("t3_")
        ? parentId
        : undefined;
  if (fullname === undefined)
    throw new TypeError("comment replies require a submission");
  const submission = objectifySubmission(
    client,
    { id: fullname.slice(3) },
    context,
  );
  context.submission = submission;
  return submission;
}

function objectifyCommentThing(
  client: RedditClientLike,
  thing: unknown,
  context: EntityContext,
): CommentNode {
  if (thing instanceof Comment || thing instanceof MoreComments) return thing;
  if (!isRawData(thing) || !isRawData(thing["data"]))
    throw new TypeError("comment listing contains an invalid thing");
  if (thing["kind"] === "t1")
    return objectifyComment(client, thing["data"], context);
  if (thing["kind"] === "more")
    return objectifyMoreComments(client, thing["data"], context);
  throw new TypeError("comment listing contains an unsupported thing");
}

function listingChildren(value: unknown): unknown[] {
  if (value === "" || value == null) return [];
  if (Array.isArray(value)) return value;
  if (isRawData(value) && value["kind"] === "Listing") value = value["data"];
  if (isRawData(value) && Array.isArray(value["children"]))
    return value["children"];
  throw new TypeError("comment listing has no children array");
}

function parseSubmissionListings(
  client: RedditClientLike,
  response: unknown,
  submission: Submission,
): [RawData, CommentNode[], EntityContext] {
  if (!Array.isArray(response) || response.length !== 2)
    throw new TypeError("submission response must contain two listings");
  const submissionChildren = listingChildren(response[0]);
  const first = submissionChildren[0];
  if (
    submissionChildren.length !== 1 ||
    !isRawData(first) ||
    first["kind"] !== "t3" ||
    !isRawData(first["data"])
  ) {
    throw new TypeError("submission response did not contain its submission");
  }
  const key = fullnameKey("t3", first["data"]);
  if (key !== submission.fullname.toLowerCase())
    throw new TypeError("submission response contained a different submission");

  const context = createEntityContext(submission);
  context.submissions.set(submission.fullname.toLowerCase(), submission);
  const comments = listingChildren(response[1]).map((thing) =>
    objectifyCommentThing(client, thing, context),
  );
  return [first["data"], comments, context];
}

function parseCommentListing(
  client: RedditClientLike,
  response: unknown,
  submission: Submission,
): CommentNode[] {
  if (!Array.isArray(response) || response.length !== 2)
    throw new TypeError("comment permalink response must contain two listings");
  const context = createEntityContext(submission);
  return listingChildren(response[1]).map((thing) =>
    objectifyCommentThing(client, thing, context),
  );
}

function fullnameKey(kind: "t1" | "t3", data: RawData): string | undefined {
  const name = data["name"];
  if (typeof name === "string") return name.toLowerCase();
  const id = data["id"];
  return typeof id === "string" ? `${kind}_${id}`.toLowerCase() : undefined;
}

function moreKey(data: RawData): string {
  const parent = typeof data["parent_id"] === "string" ? data["parent_id"] : "";
  const children = Array.isArray(data["children"])
    ? data["children"].join(",")
    : "";
  const count = typeof data["count"] === "number" ? data["count"] : 0;
  return `${parent.toLowerCase()}:${count}:${children}`;
}

export type RedditEntity =
  | Comment
  | MessageBase
  | MoreComments
  | Redditor
  | Submission
  | Subreddit
  | UserSubreddit;
