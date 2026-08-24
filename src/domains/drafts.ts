import { ReadOnlyError } from "../exceptions.js";
import { Objector } from "../objector.js";
import {
  RedditModel,
  isRawData,
  type LoadOptions,
  type RawData,
  type RedditClientLike,
  type RedditRequest,
} from "../models/base.js";
import { Submission, Subreddit } from "../models/entities.js";

export interface DraftsClient extends RedditClientLike {
  readonly readOnly: boolean;
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

export interface DraftUpdateOptions {
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

export interface DraftSubmitOptions {
  readonly flairId?: string;
  readonly flairText?: string;
  readonly nsfw?: boolean;
  readonly resubmit?: boolean;
  readonly selftext?: string;
  readonly sendReplies?: boolean;
  readonly signal?: AbortSignal;
  readonly spoiler?: boolean;
  readonly subreddit?: string | Subreddit;
  readonly title?: string;
  readonly url?: string;
}

function assertAuthorized(client: DraftsClient, operation: string): void {
  if (client.readOnly)
    throw new ReadOnlyError(`${operation} does not work in read-only mode`);
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return normalized;
}

function subredditName(value: string | Subreddit): string {
  return nonEmpty(String(value), "subreddit");
}

function validateBody(options: DraftCreateOptions | DraftUpdateOptions): void {
  if (options.selftext !== undefined && options.url !== undefined)
    throw new TypeError("Exactly one of selftext or url may be provided");
  if (options.flairText !== undefined && options.flairId === undefined)
    throw new TypeError("flairId is required when flairText is provided");
}

function unwrap(value: unknown, model: string): RawData {
  let data = value;
  if (isRawData(data) && isRawData(data["json"])) data = data["json"];
  if (isRawData(data) && isRawData(data["data"])) data = data["data"];
  if (isRawData(data)) return data;
  throw new TypeError(`Reddit returned invalid ${model} data`);
}

function draftData(value: unknown): RawData {
  let data = unwrap(value, "draft");
  if (isRawData(data["draft"])) data = data["draft"];
  if (typeof data["id"] !== "string")
    throw new TypeError("Reddit returned invalid draft data");
  const result = { ...data };
  if (
    (data["kind"] === "markdown" || data["kind"] === "richtext") &&
    "body" in data
  ) {
    result["selftext"] = data["body"];
    delete result["body"];
  } else if (data["kind"] === "link" && "body" in data) {
    result["url"] = data["body"];
    delete result["body"];
  }
  return result;
}

function objectifiedDraftData(client: DraftsClient, value: unknown): RawData {
  const data = draftData(value);
  const subreddit = data["subreddit"];
  return typeof subreddit === "string"
    ? { ...data, subreddit: new Subreddit(client, subreddit) }
    : data;
}

function listData(value: unknown): unknown[] {
  let data = value;
  if (isRawData(data) && isRawData(data["data"])) data = data["data"];
  if (isRawData(data) && Array.isArray(data["drafts"])) data = data["drafts"];
  if (!Array.isArray(data))
    throw new TypeError("Reddit returned invalid drafts data");
  return data;
}

function prepareDraftData(
  options: DraftCreateOptions | DraftUpdateOptions,
  defaults: boolean,
): Record<string, boolean | string> {
  validateBody(options);
  const data: Record<string, boolean | string> = {};
  if (defaults || options.isPublicLink !== undefined)
    data["is_public_link"] = options.isPublicLink ?? false;
  if (defaults || options.nsfw !== undefined)
    data["nsfw"] = options.nsfw ?? false;
  if (defaults || options.originalContent !== undefined)
    data["original_content"] = options.originalContent ?? false;
  if (defaults || options.sendReplies !== undefined)
    data["send_replies"] = options.sendReplies ?? true;
  if (defaults || options.spoiler !== undefined)
    data["spoiler"] = options.spoiler ?? false;
  data["kind"] = options.selftext !== undefined ? "markdown" : "link";
  if (options.selftext !== undefined) data["body"] = options.selftext;
  else if (options.url !== undefined) data["body"] = options.url;
  if (options.flairId !== undefined) data["flair_id"] = options.flairId;
  if (options.flairText !== undefined) data["flair_text"] = options.flairText;
  if (options.title !== undefined) data["title"] = options.title;
  if (options.subreddit !== undefined) {
    const name = subredditName(options.subreddit);
    data["subreddit"] = name;
    data["target"] = name.startsWith("u_") ? "profile" : "subreddit";
  }
  return data;
}

function findSubmission(value: unknown): Submission | undefined {
  if (value instanceof Submission) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSubmission(item);
      if (found !== undefined) return found;
    }
  } else if (isRawData(value)) {
    for (const item of Object.values(value)) {
      const found = findSubmission(item);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export class Draft extends RedditModel {
  readonly kind = "draft";
  readonly identityField = "id";
  declare selftext: unknown;
  declare subreddit: unknown;
  declare title: unknown;
  declare url: unknown;

  constructor(client: DraftsClient, value: string | RawData) {
    super(
      client,
      "id",
      typeof value === "string"
        ? nonEmpty(value, "draft ID")
        : objectifiedDraftData(client, value),
    );
  }

  override async refresh(options: LoadOptions = {}): Promise<this> {
    assertAuthorized(this.draftsClient, "draft.refresh()");
    options.signal?.throwIfAborted();
    const drafts = await fetchDrafts(this.draftsClient, options.signal);
    const found = drafts.find((draft) => draft.equals(this));
    if (found === undefined)
      throw new TypeError(
        `Reddit response did not contain draft ${this.toString()}`,
      );
    this.applyLoadedData({ ...found.raw });
    return this;
  }

  async update(
    options: DraftUpdateOptions,
    signal?: AbortSignal,
  ): Promise<this> {
    assertAuthorized(this.draftsClient, "draft.update()");
    signal?.throwIfAborted();
    const response = await this.draftsClient.request({
      method: "PUT",
      path: "/api/v1/draft",
      data: { ...prepareDraftData(options, false), id: this.toString() },
      ...(signal === undefined ? {} : { signal }),
    });
    new Objector(this.draftsClient).objectify(response);
    return this.refresh(signal === undefined ? {} : { signal });
  }

  async delete(signal?: AbortSignal): Promise<void> {
    assertAuthorized(this.draftsClient, "draft.delete()");
    signal?.throwIfAborted();
    const response = await this.draftsClient.request({
      method: "DELETE",
      path: "/api/v1/draft",
      params: { draft_id: this.toString() },
      ...(signal === undefined ? {} : { signal }),
    });
    new Objector(this.draftsClient).objectify(response);
  }

  async submit(options: DraftSubmitOptions = {}): Promise<Submission> {
    assertAuthorized(this.draftsClient, "draft.submit()");
    options.signal?.throwIfAborted();
    if (options.selftext !== undefined && options.url !== undefined)
      throw new TypeError("Exactly one of selftext or url may be provided");
    if (options.flairText !== undefined && options.flairId === undefined)
      throw new TypeError("flairId is required when flairText is provided");

    if (!this.isLoaded)
      await this.load({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    const ownSubreddit = this.get("subreddit");
    const subreddit =
      options.subreddit ??
      (ownSubreddit instanceof Subreddit || typeof ownSubreddit === "string"
        ? ownSubreddit
        : undefined);
    if (subreddit === undefined)
      throw new TypeError("subreddit must be set on the draft or provided");
    const selftext = options.selftext ?? this.get<string>("selftext");
    const url = options.url ?? this.get<string>("url");
    if (selftext !== undefined && options.url !== undefined)
      throw new TypeError("Exactly one of selftext or url may be provided");
    const data: Record<string, boolean | string> = {
      draft_id: this.toString(),
      kind: selftext !== undefined ? "self" : "link",
      nsfw: options.nsfw ?? this.get<boolean>("nsfw") ?? false,
      resubmit: options.resubmit ?? true,
      sendreplies:
        options.sendReplies ?? this.get<boolean>("send_replies") ?? true,
      spoiler: options.spoiler ?? this.get<boolean>("spoiler") ?? false,
      sr: subredditName(subreddit),
      title: options.title ?? this.get<string>("title") ?? "",
      validate_on_submit: false,
    };
    if (selftext !== undefined) data["text"] = selftext;
    else if (url !== undefined) data["url"] = url;
    const flairId =
      options.flairId ?? this.get<string>("link_flair_template_id");
    const flairText = options.flairText ?? this.get<string>("link_flair_text");
    if (flairId !== undefined) data["flair_id"] = flairId;
    if (flairText !== undefined) data["flair_text"] = flairText;
    const response = await this.draftsClient.request({
      method: "POST",
      path: "/api/submit",
      data,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const submission = findSubmission(
      new Objector(this.draftsClient).objectify(response),
    );
    if (submission === undefined)
      throw new TypeError(
        "Reddit response did not contain submitted Submission data",
      );
    return submission;
  }

  protected fetchRequest(): Pick<RedditRequest, "path"> {
    return { path: "/api/v1/drafts" };
  }

  private get draftsClient(): DraftsClient {
    return this.client as DraftsClient;
  }
}

async function fetchDrafts(
  client: DraftsClient,
  signal?: AbortSignal,
): Promise<Draft[]> {
  assertAuthorized(client, "drafts.list()");
  signal?.throwIfAborted();
  const response = await client.request({
    method: "GET",
    path: "/api/v1/drafts",
    params: { md_body: true },
    ...(signal === undefined ? {} : { signal }),
  });
  new Objector(client).objectify(response);
  return listData(response).map((value) => new Draft(client, draftData(value)));
}

export class DraftsDomain {
  readonly #client: DraftsClient;

  constructor(client: DraftsClient) {
    this.#client = client;
  }

  reference(id: string): Draft {
    assertAuthorized(this.#client, "drafts.reference()");
    return new Draft(this.#client, id);
  }

  list(signal?: AbortSignal): Promise<Draft[]> {
    return fetchDrafts(this.#client, signal);
  }

  async create(
    options: DraftCreateOptions,
    signal?: AbortSignal,
  ): Promise<Draft> {
    assertAuthorized(this.#client, "drafts.create()");
    signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "POST",
      path: "/api/v1/draft",
      data: prepareDraftData(options, true),
      ...(signal === undefined ? {} : { signal }),
    });
    new Objector(this.#client).objectify(response);
    return new Draft(this.#client, draftData(response));
  }
}
