import { Objector } from "../objector.js";
import { isRawData, type RawData } from "../models/base.js";
import {
  LiveThread,
  requiredLiveString,
  type LiveClient,
} from "../models/live.js";
import { ReadOnlyError } from "../exceptions.js";

export interface LiveCreateOptions {
  readonly description?: string;
  readonly nsfw?: boolean;
  readonly resources?: string;
  readonly signal?: AbortSignal;
}

function authorized(client: LiveClient, operation: string): void {
  if (client.readOnly === true)
    throw new ReadOnlyError(`${operation} does not work in read-only mode`);
}

function threadData(value: unknown): RawData {
  let result = value;
  if (isRawData(result) && isRawData(result["json"])) result = result["json"];
  if (isRawData(result) && isRawData(result["data"])) result = result["data"];
  if (!isRawData(result))
    throw new TypeError("Reddit returned invalid live thread data");
  return result;
}

function threadFrom(client: LiveClient, value: unknown): LiveThread {
  const objectified = new Objector(client, {
    LiveThread: (modelClient, data) => new LiveThread(modelClient, data),
  }).objectify(value);
  if (objectified instanceof LiveThread) return objectified;
  return new LiveThread(client, threadData(value));
}

function infoChildren(value: unknown): readonly unknown[] {
  let result = value;
  if (isRawData(result) && result["kind"] === "Listing")
    result = result["data"];
  if (!isRawData(result) || !Array.isArray(result["children"]))
    throw new TypeError("Reddit returned invalid live thread info data");
  return result["children"];
}

export class LiveDomain {
  readonly #client: LiveClient;

  constructor(client: LiveClient) {
    this.#client = client;
  }

  reference(id: string): LiveThread {
    return new LiveThread(
      this.#client,
      requiredLiveString(id, "live thread ID"),
    );
  }

  async create(
    title: string,
    options: LiveCreateOptions = {},
  ): Promise<LiveThread> {
    authorized(this.#client, "live.create()");
    options.signal?.throwIfAborted();
    const normalizedTitle = requiredLiveString(title, "title");
    if (normalizedTitle.length > 120)
      throw new RangeError("title cannot exceed 120 characters");
    const response = await this.#client.request({
      method: "POST",
      path: "/api/live/create",
      data: {
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        nsfw: options.nsfw ?? false,
        ...(options.resources === undefined
          ? {}
          : { resources: options.resources }),
        title: normalizedTitle,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    new Objector(this.#client).objectify(response);
    return threadFrom(this.#client, response);
  }

  info(
    ids: readonly string[],
    signal?: AbortSignal,
  ): AsyncGenerator<LiveThread> {
    if (
      !Array.isArray(ids) ||
      !ids.every((id): id is string => typeof id === "string")
    )
      throw new TypeError("ids must be an array of strings");
    const normalized = ids.map((id) =>
      requiredLiveString(id, "live thread ID"),
    );
    const client = this.#client;
    return (async function* (): AsyncGenerator<LiveThread> {
      for (let index = 0; index < normalized.length; index += 100) {
        signal?.throwIfAborted();
        const chunk = normalized.slice(index, index + 100);
        const response = await client.request({
          method: "GET",
          path: `/api/live/by_id/${chunk.map((id) => encodeURIComponent(id)).join(",")}`,
          params: { limit: 100 },
          ...(signal === undefined ? {} : { signal }),
        });
        for (const child of infoChildren(response))
          yield threadFrom(client, child);
      }
    })();
  }

  async now(signal?: AbortSignal): Promise<LiveThread | null> {
    signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: "/api/live/happening_now",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response === null) return null;
    if (isRawData(response) && response["data"] === null) return null;
    return threadFrom(this.#client, response);
  }
}
