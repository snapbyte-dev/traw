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
  UserContentMixin,
  type ActionOptions,
} from "./mixins.js";
import { PostMedia } from "./media.js";
import { RedditAPIException, type RedditError } from "../exceptions.js";

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

  constructor(
    client: RedditClientLike,
    value: string | RawData,
    context?: EntityContext,
  ) {
    super(client, "t1", value);
    if (typeof value !== "string") {
      const entityContext = context ?? createEntityContext();
      entityContext.comments.set(this.fullname.toLowerCase(), this);
      this.applyObjectifiedData(value, entityContext);
    }
  }

  applyObjectifiedData(data: RawData, context: EntityContext): void {
    this.applyData(objectifyEntityFields(this.client, data, context));
  }

  protected createReply(data: RawData): Comment {
    return new Comment(this.client, data);
  }
}

export class Submission extends SubmissionMixin {
  readonly kind = "t3";
  declare author: unknown;
  declare selftext: unknown;
  declare subreddit: unknown;
  declare title: unknown;
  comments: CommentForest | undefined;
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

export class Message extends RedditModel {
  readonly kind = "t4";
  readonly identityField = "id";
  declare author: unknown;
  declare body: unknown;
  declare subject: unknown;

  constructor(client: RedditClientLike, value: string | RawData) {
    super(
      client,
      "id",
      typeof value === "string" && value.startsWith("t4_")
        ? value.slice(3)
        : value,
    );
  }

  get fullname(): string {
    const name = this.get("name");
    return typeof name === "string" ? name : `t4_${this.toString()}`;
  }

  protected fetchRequest(): Pick<RedditRequest, "params" | "path"> {
    return { path: "/api/info", params: { id: this.fullname } };
  }
}

export class Redditor extends RedditModel {
  readonly kind = "t2";
  readonly identityField = "name";
  declare comment_karma: unknown;
  declare link_karma: unknown;

  constructor(client: RedditClientLike, value: string | RawData) {
    super(client, "name", value);
  }

  applyObjectifiedData(data: RawData): void {
    this.applyData(data);
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
          throw new RedditAPIException(errors as readonly RedditError[]);
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
    return postRequest(this.client, "/api/submit", data, options.signal);
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

export type SubmitOptions = CommonSubmitOptions &
  (
    | { readonly kind: "text"; readonly selftext: string }
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
    | {
        readonly image: PostMedia;
        readonly kind: "image";
        readonly selftext?: string;
      }
    | {
        readonly gif?: boolean;
        readonly kind: "video";
        readonly selftext?: string;
        readonly thumbnail?: PostMedia;
        readonly video: PostMedia;
      }
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
  Comment | Message | MoreComments | Redditor | Submission | Subreddit;
