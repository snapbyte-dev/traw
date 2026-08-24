import { replayableMultipart } from "../core/transport.js";
import { ResponseException, ServerError } from "../exceptions.js";
import { BaseModel, isRawData, type RawData } from "../models/base.js";
import {
  assertModeratorAccess,
  requiredString,
  subredditName,
  subredditPath,
  type ModerationClientLike,
  type SubredditReference,
} from "../models/moderation.js";
import { EmojiMedia } from "../models/public.js";

export interface EmojiPermissions {
  readonly modFlairOnly?: boolean;
  readonly postFlairAllowed?: boolean;
  readonly userFlairAllowed?: boolean;
}

export interface EmojiUploadOptions extends EmojiPermissions {
  readonly media: EmojiMedia;
  readonly name: string;
}

interface UploadLease {
  readonly fields: readonly (readonly [string, string])[];
  readonly url: string;
}

function leaseData(value: unknown): UploadLease {
  if (!isRawData(value) || !isRawData(value["s3UploadLease"])) {
    throw new TypeError("emoji media lease response is missing s3UploadLease");
  }
  const lease = value["s3UploadLease"];
  const action = lease["action"];
  const rawFields = lease["fields"];
  if (typeof action !== "string" || !Array.isArray(rawFields)) {
    throw new TypeError("emoji media lease response is malformed");
  }
  const fields = rawFields.map((field): readonly [string, string] => {
    if (
      !isRawData(field) ||
      typeof field["name"] !== "string" ||
      typeof field["value"] !== "string"
    ) {
      throw new TypeError(
        "emoji media lease response contains a malformed field",
      );
    }
    return [field["name"], field["value"]];
  });
  return {
    fields,
    url: action.startsWith("//") ? `https:${action}` : action,
  };
}

function uploadFailure(error: unknown): never {
  if (!(error instanceof ResponseException)) throw error;
  throw new ServerError(error.response);
}

async function uploadMedia(
  client: ModerationClientLike,
  subreddit: SubredditReference,
  media: EmojiMedia,
  signal?: AbortSignal,
): Promise<string> {
  if (!(media instanceof EmojiMedia)) {
    throw new TypeError("media must be an EmojiMedia instance");
  }
  signal?.throwIfAborted();
  const lease = leaseData(
    await client.request({
      method: "POST",
      path: `/api/v1/${subredditPath(subreddit)}/emoji_asset_upload_s3.json`,
      data: { filepath: media.name, mimetype: media.mimeType },
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  const body = replayableMultipart(lease.fields, {
    bytes: media.create(),
    contentType: media.mimeType,
    name: media.name,
  });
  signal?.throwIfAborted();
  try {
    await client.request({
      auth: false,
      data: body,
      method: "POST",
      path: lease.url,
      rawJson: false,
      responseType: "text",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    uploadFailure(error);
  }
  const key = lease.fields.find(([name]) => name === "key")?.[1];
  if (key === undefined) {
    throw new TypeError("emoji media lease response is missing key");
  }
  return key;
}

function emojiMap(value: unknown): RawData {
  if (!isRawData(value)) {
    throw new TypeError("Reddit returned invalid emoji data");
  }
  let map: RawData | undefined;
  for (const [key, candidate] of Object.entries(value)) {
    if (!key.startsWith("t5_") || !isRawData(candidate)) continue;
    if (map !== undefined) {
      throw new TypeError("Reddit returned invalid emoji data");
    }
    map = candidate;
  }
  if (map === undefined) {
    throw new TypeError("Reddit returned invalid emoji data");
  }
  return map;
}

function permissionData(
  permissions: EmojiPermissions,
): Record<string, boolean> {
  const data: Record<string, boolean> = {};
  if (permissions.modFlairOnly !== undefined) {
    data["mod_flair_only"] = permissions.modFlairOnly;
  }
  if (permissions.postFlairAllowed !== undefined) {
    data["post_flair_allowed"] = permissions.postFlairAllowed;
  }
  if (permissions.userFlairAllowed !== undefined) {
    data["user_flair_allowed"] = permissions.userFlairAllowed;
  }
  return data;
}

export class Emoji extends BaseModel {
  readonly subreddit: SubredditReference;
  declare mod_flair_only: unknown;
  declare name: unknown;
  declare post_flair_allowed: unknown;
  declare url: unknown;
  declare user_flair_allowed: unknown;

  constructor(
    client: ModerationClientLike,
    subreddit: SubredditReference,
    value: string | RawData,
  ) {
    const data =
      typeof value === "string"
        ? { name: requiredString(value, "emoji name") }
        : value;
    if (typeof data["name"] !== "string") {
      throw new TypeError("Emoji has no valid name");
    }
    super(client, data);
    this.subreddit = subreddit;
    subredditName(subreddit);
  }

  override toString(): string {
    const name = this.get("name");
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("Emoji has no valid name");
    }
    return name;
  }

  async refresh(signal?: AbortSignal): Promise<this> {
    const found = (
      await fetchEmojis(this.emojiClient, this.subreddit, signal)
    ).find((emoji) => String(emoji) === String(this));
    if (found === undefined) {
      throw new TypeError(
        `r/${subredditName(this.subreddit)} does not have the emoji ${this.toString()}`,
      );
    }
    this.applyData(found.raw);
    return this;
  }

  async update(
    permissions: EmojiPermissions,
    signal?: AbortSignal,
  ): Promise<this> {
    assertModeratorAccess(this.emojiClient, "emoji.update()");
    signal?.throwIfAborted();
    const supplied = permissionData(permissions);
    if (Object.keys(supplied).length === 0) {
      throw new TypeError("At least one emoji permission must be provided");
    }
    const fields = [
      "mod_flair_only",
      "post_flair_allowed",
      "user_flair_allowed",
    ] as const;
    if (fields.some((field) => supplied[field] === undefined)) {
      await this.refresh(signal);
    }
    const data: Record<string, boolean | string> = { name: this.toString() };
    for (const field of fields) {
      const value = supplied[field] ?? this.get(field);
      if (typeof value !== "boolean") {
        throw new TypeError(`Emoji has no valid ${field}`);
      }
      data[field] = value;
    }
    await this.emojiClient.request({
      method: "POST",
      path: `/api/v1/${subredditPath(this.subreddit)}/emoji_permissions`,
      data,
      ...(signal === undefined ? {} : { signal }),
    });
    this.applyData(data);
    return this;
  }

  async delete(signal?: AbortSignal): Promise<void> {
    assertModeratorAccess(this.emojiClient, "emoji.delete()");
    signal?.throwIfAborted();
    await this.emojiClient.request({
      method: "DELETE",
      path: `/api/v1/${subredditPath(this.subreddit)}/emoji/${encodeURIComponent(this.toString())}`,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private get emojiClient(): ModerationClientLike {
    return this.client;
  }
}

async function fetchEmojis(
  client: ModerationClientLike,
  subreddit: SubredditReference,
  signal?: AbortSignal,
): Promise<Emoji[]> {
  signal?.throwIfAborted();
  const response = await client.request({
    method: "GET",
    path: `/api/v1/${subredditPath(subreddit)}/emojis/all`,
    ...(signal === undefined ? {} : { signal }),
  });
  return Object.entries(emojiMap(response)).map(([name, data]) => {
    if (!isRawData(data)) {
      throw new TypeError("Reddit returned invalid emoji data");
    }
    return new Emoji(client, subreddit, { ...data, name });
  });
}

export class SubredditEmoji {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.#client = client;
    this.#subreddit = subreddit;
    subredditName(subreddit);
  }

  get(name: string): Emoji {
    return new Emoji(this.#client, this.#subreddit, name);
  }

  list(signal?: AbortSignal): Promise<Emoji[]> {
    return fetchEmojis(this.#client, this.#subreddit, signal);
  }

  async upload(
    options: EmojiUploadOptions,
    signal?: AbortSignal,
  ): Promise<Emoji> {
    assertModeratorAccess(this.#client, "emoji.upload()");
    const name = requiredString(options.name, "emoji name");
    const key = await uploadMedia(
      this.#client,
      this.#subreddit,
      options.media,
      signal,
    );
    signal?.throwIfAborted();
    await this.#client.request({
      method: "POST",
      path: `/api/v1/${subredditPath(this.#subreddit)}/emoji.json`,
      data: { ...permissionData(options), name, s3_key: key },
      ...(signal === undefined ? {} : { signal }),
    });
    return this.get(name);
  }

  add(options: EmojiUploadOptions, signal?: AbortSignal): Promise<Emoji> {
    return this.upload(options, signal);
  }

  update(
    name: string,
    permissions: EmojiPermissions,
    signal?: AbortSignal,
  ): Promise<Emoji> {
    return this.get(name).update(permissions, signal);
  }

  delete(name: string, signal?: AbortSignal): Promise<void> {
    return this.get(name).delete(signal);
  }
}

export function createSubredditEmoji(
  client: ModerationClientLike,
  subreddit: SubredditReference,
): SubredditEmoji {
  return new SubredditEmoji(client, subreddit);
}
