import { isRawData } from "../models/base.js";
import {
  RemovalReason,
  assertModeratorAccess,
  requiredString,
  subredditName,
  subredditPath,
  type ModerationClientLike,
  type SubredditReference,
} from "../models/moderation.js";

export interface RemovalReasonOptions {
  readonly message: string;
  readonly title: string;
}

export interface UpdateRemovalReasonOptions {
  readonly message?: string;
  readonly title?: string;
}

export class SubredditRemovalReasons {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.#client = client;
    this.#subreddit = subreddit;
    subredditName(subreddit);
  }

  get(id: string): RemovalReason {
    return new RemovalReason(
      this.#client,
      this.#subreddit,
      requiredString(id, "removal reason ID"),
    );
  }

  async list(signal?: AbortSignal): Promise<RemovalReason[]> {
    assertModeratorAccess(this.#client, "removalReasons.list()");
    const response = await this.#client.request({
      method: "GET",
      path: `/api/v1/${subredditPath(this.#subreddit)}/removal_reasons`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      !isRawData(response) ||
      !isRawData(response["data"]) ||
      !Array.isArray(response["order"])
    ) {
      throw new TypeError("Reddit returned invalid removal reasons data");
    }
    const data = response["data"];
    return response["order"].map((id) => {
      if (typeof id !== "string" || !isRawData(data[id]))
        throw new TypeError("Reddit returned invalid removal reason data");
      return new RemovalReason(this.#client, this.#subreddit, data[id]);
    });
  }

  async add(
    options: RemovalReasonOptions,
    signal?: AbortSignal,
  ): Promise<RemovalReason> {
    assertModeratorAccess(this.#client, "removalReasons.add()");
    const response = await this.#client.request({
      method: "POST",
      path: `/api/v1/${subredditPath(this.#subreddit)}/removal_reasons`,
      data: {
        message: requiredString(options.message, "message"),
        title: requiredString(options.title, "title"),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (typeof response !== "string")
      throw new TypeError("Reddit returned invalid removal reason ID");
    return this.get(response);
  }

  async update(
    reason: string | RemovalReason,
    options: UpdateRemovalReasonOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "removalReasons.update()");
    const id = requiredString(String(reason), "removal reason ID");
    let message = options.message;
    let title = options.title;
    if (message === undefined || title === undefined) {
      const existing = (await this.list(signal)).find(
        (item) => String(item) === id,
      );
      if (existing === undefined)
        throw new TypeError(`Subreddit does not have removal reason ${id}`);
      const raw = existing.raw;
      if (message === undefined && typeof raw["message"] === "string")
        message = raw["message"];
      if (title === undefined && typeof raw["title"] === "string")
        title = raw["title"];
    }
    if (message === undefined || title === undefined)
      throw new TypeError("Removal reason has incomplete data");
    await this.#client.request({
      method: "PUT",
      path: `/api/v1/${subredditPath(this.#subreddit)}/removal_reasons/${encodeURIComponent(id)}`,
      data: { message, title },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async delete(
    reason: string | RemovalReason,
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "removalReasons.delete()");
    const id = requiredString(String(reason), "removal reason ID");
    await this.#client.request({
      method: "DELETE",
      path: `/api/v1/${subredditPath(this.#subreddit)}/removal_reasons/${encodeURIComponent(id)}`,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export function createSubredditRemovalReasons(
  client: ModerationClientLike,
  subreddit: SubredditReference,
): SubredditRemovalReasons {
  return new SubredditRemovalReasons(client, subreddit);
}
