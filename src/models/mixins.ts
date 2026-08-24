import {
  RedditModel,
  isRawData,
  postRequest,
  type DataValue,
  type RawData,
  type RedditClientLike,
  type RedditRequest,
} from "./base.js";
import type { Comment } from "./entities.js";

export interface ActionOptions {
  readonly signal?: AbortSignal;
}

export type DistinguishHow = "admin" | "no" | "special" | "yes";

export interface DistinguishOptions extends ActionOptions {
  readonly how?: DistinguishHow;
  readonly sticky?: boolean;
}

export interface RemoveOptions extends ActionOptions {
  readonly modNote?: string;
  readonly reasonId?: string;
  readonly spam?: boolean;
}

const EDIT_EXCLUDED_FIELDS = new Set([
  "_fetched",
  "_reddit",
  "_submission",
  "replies",
  "subreddit",
]);

function bareId(value: string, kind: string): string {
  return value.startsWith(`${kind}_`) ? value.slice(kind.length + 1) : value;
}

/** Shared request behavior for comments and submissions. */
export abstract class UserContentMixin extends RedditModel {
  readonly identityField = "id";
  #moderation: ThingModeration | undefined;

  constructor(client: RedditClientLike, kind: string, value: string | RawData) {
    super(
      client,
      "id",
      typeof value === "string" ? bareId(value, kind) : value,
    );
  }

  get fullname(): string {
    const name = this.get("name");
    return typeof name === "string" ? name : `${this.kind}_${this.toString()}`;
  }

  get mod(): ThingModeration {
    return (this.#moderation ??= this.createModeration());
  }

  reply(body: string, options: ActionOptions = {}): Promise<Comment> {
    return this.post(
      "/api/comment",
      { text: body, thing_id: this.fullname },
      options,
    ).then((response) => {
      const comment = findMutationThing(response, "t1");
      if (comment instanceof RedditModel) return comment as Comment;
      if (comment !== undefined) return this.createReply(comment);
      throw new TypeError(
        "Reddit response did not contain created Comment data",
      );
    });
  }

  edit(body: string, options: ActionOptions = {}): Promise<this> {
    return this.post(
      "/api/editusertext",
      {
        text: body,
        thing_id: this.fullname,
        validate_on_submit: true,
      },
      options,
    ).then((response) => this.applyEditResponse(response));
  }

  protected applyEditResponse(response: unknown): this {
    const updated = findMutationThing(response, this.kind);
    if (updated === undefined)
      throw new TypeError(
        `Reddit response did not contain updated ${this.constructor.name} data`,
      );
    const data = updated instanceof RedditModel ? updated.raw : updated;
    const retained = Object.fromEntries(
      Object.entries(data).filter(
        ([field]) => !EDIT_EXCLUDED_FIELDS.has(field),
      ),
    );
    this.applyData(retained);
    return this;
  }

  delete(options: ActionOptions = {}): Promise<unknown> {
    return this.post("/api/del", { id: this.fullname }, options);
  }

  vote(direction: -1 | 0 | 1, options: ActionOptions = {}): Promise<unknown> {
    return this.post(
      "/api/vote",
      { dir: direction, id: this.fullname },
      options,
    );
  }

  upvote(options: ActionOptions = {}): Promise<unknown> {
    return this.vote(1, options);
  }

  downvote(options: ActionOptions = {}): Promise<unknown> {
    return this.vote(-1, options);
  }

  clearVote(options: ActionOptions = {}): Promise<unknown> {
    return this.vote(0, options);
  }

  save(category?: string, options: ActionOptions = {}): Promise<unknown> {
    return this.post(
      "/api/save",
      category === undefined
        ? { id: this.fullname }
        : { category, id: this.fullname },
      options,
    );
  }

  unsave(options: ActionOptions = {}): Promise<unknown> {
    return this.post("/api/unsave", { id: this.fullname }, options);
  }

  report(reason: string, options: ActionOptions = {}): Promise<unknown> {
    return this.post("/api/report", { id: this.fullname, reason }, options);
  }

  disableInboxReplies(options: ActionOptions = {}): Promise<unknown> {
    return this.inboxReplies(false, options);
  }

  enableInboxReplies(options: ActionOptions = {}): Promise<unknown> {
    return this.inboxReplies(true, options);
  }

  protected fetchRequest(): Pick<RedditRequest, "params" | "path"> {
    return { path: "/api/info", params: { id: this.fullname } };
  }

  protected post(
    path: string,
    data: Readonly<Record<string, DataValue>>,
    options: ActionOptions,
  ): Promise<unknown> {
    return postRequest(this.client, path, data, options.signal);
  }

  protected createModeration(): ThingModeration {
    return new ThingModeration(this);
  }

  protected abstract createReply(data: RawData): Comment;

  private inboxReplies(
    state: boolean,
    options: ActionOptions,
  ): Promise<unknown> {
    return this.post("/api/sendreplies", { id: this.fullname, state }, options);
  }
}

/** PRAW's shared comment/submission moderation actions. */
export class ThingModeration<T extends UserContentMixin = UserContentMixin> {
  readonly thing: T;

  constructor(thing: T) {
    this.thing = thing;
  }

  approve(options: ActionOptions = {}): Promise<unknown> {
    return this.action("/api/approve/", options);
  }

  ignoreReports(options: ActionOptions = {}): Promise<unknown> {
    return this.action("/api/ignore_reports/", options);
  }

  unignoreReports(options: ActionOptions = {}): Promise<unknown> {
    return this.action("/api/unignore_reports/", options);
  }

  lock(options: ActionOptions = {}): Promise<unknown> {
    return this.action("/api/lock/", options);
  }

  unlock(options: ActionOptions = {}): Promise<unknown> {
    return this.action("/api/unlock/", options);
  }

  distinguish(options: DistinguishOptions = {}): Promise<unknown> {
    const how = options.how ?? "yes";
    if (!["admin", "no", "special", "yes"].includes(how))
      throw new RangeError(`Invalid distinguish mode: ${how}`);
    return postRequest(
      this.thing.client,
      "/api/distinguish/",
      {
        how,
        id: this.thing.fullname,
        ...(options.sticky === true && this.isRootComment()
          ? { sticky: true }
          : {}),
      },
      options.signal,
    );
  }

  undistinguish(options: ActionOptions = {}): Promise<unknown> {
    return this.distinguish({ ...options, how: "no" });
  }

  async remove(options: RemoveOptions = {}): Promise<unknown> {
    if (
      (options.reasonId !== undefined || options.modNote !== undefined) &&
      !options.reasonId &&
      !options.modNote
    )
      throw new TypeError("modNote cannot be blank without reasonId");
    const response = await postRequest(
      this.thing.client,
      "/api/remove/",
      { id: this.thing.fullname, spam: options.spam ?? false },
      options.signal,
    );
    if (options.reasonId !== undefined || options.modNote !== undefined) {
      await postRequest(
        this.thing.client,
        "/api/v1/modactions/removal_reasons",
        {
          json: JSON.stringify({
            item_ids: [this.thing.fullname],
            mod_note: options.modNote ?? "",
            reason_id: options.reasonId ?? null,
          }),
        },
        options.signal,
      );
    }
    return response;
  }

  protected action(path: string, options: ActionOptions): Promise<unknown> {
    return postRequest(
      this.thing.client,
      path,
      { id: this.thing.fullname },
      options.signal,
    );
  }

  private isRootComment(): boolean {
    return (
      this.thing.kind === "t1" &&
      this.thing.get("parent_id")?.toString().startsWith("t3_") === true
    );
  }
}

function findMutationThing(
  value: unknown,
  kind: string,
): RawData | RedditModel | undefined {
  if (value instanceof RedditModel)
    return value.kind === kind ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMutationThing(item, kind);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRawData(value)) return undefined;
  if (value["kind"] === kind && isRawData(value["data"])) return value["data"];
  for (const field of ["json", "data", "things"] as const) {
    const found = findMutationThing(value[field], kind);
    if (found !== undefined) return found;
  }
  return typeof value["id"] === "string" ? value : undefined;
}

/** Submission-only visibility actions. */
export abstract class SubmissionMixin extends UserContentMixin {
  hide(options: ActionOptions = {}): Promise<unknown> {
    return this.post("/api/hide", { id: this.fullname }, options);
  }

  unhide(options: ActionOptions = {}): Promise<unknown> {
    return this.post("/api/unhide", { id: this.fullname }, options);
  }
}
