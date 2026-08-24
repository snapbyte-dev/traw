import {
  isRawData,
  type QueryValue,
  type RedditClientLike,
} from "./models/base.js";
import { Objector } from "./objector.js";

export interface ListingOptions {
  readonly limit?: number | null;
  readonly objector?: Objector;
  readonly pageAdapter?: ListingPageAdapter;
  readonly params?: Readonly<Record<string, QueryValue>>;
  readonly requestLimit?: number;
  readonly signal?: AbortSignal;
}

export interface ListingPage {
  readonly children: readonly unknown[];
  readonly cursor: string | null;
}

export interface ListingPageAdapter {
  readonly childKind?: string;
  readonly childName?: string;
  readonly cursorParam: "after" | "before";
  page(value: unknown): ListingPage;
}

function cursorFrom(value: unknown): string | null {
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new TypeError("Reddit listing cursor must be a string or null");
  }
  return value ?? null;
}

const standardPageAdapter: ListingPageAdapter = {
  cursorParam: "after",
  page(value: unknown): ListingPage {
    let data = value;
    if (isRawData(data) && data["kind"] === "Listing") data = data["data"];
    if (!isRawData(data) || !Array.isArray(data["children"])) {
      throw new TypeError("Reddit listing response has no children array");
    }
    return { children: data["children"], cursor: cursorFrom(data["after"]) };
  },
};

export const announcementsPageAdapter: ListingPageAdapter = {
  childKind: "ann",
  childName: "announcement",
  cursorParam: "after",
  page(value: unknown): ListingPage {
    if (!isRawData(value) || !Array.isArray(value["data"])) {
      throw new TypeError("Reddit announcement response has no data array");
    }
    return { children: value["data"], cursor: cursorFrom(value["after"]) };
  },
};

export const moderatorNotesPageAdapter: ListingPageAdapter = {
  childKind: "mod_note",
  childName: "moderator note",
  cursorParam: "before",
  page(value: unknown): ListingPage {
    if (!isRawData(value) || !Array.isArray(value["mod_notes"])) {
      throw new TypeError(
        "Reddit moderator notes response has no mod_notes array",
      );
    }
    if (typeof value["has_next_page"] !== "boolean") {
      throw new TypeError(
        "Reddit moderator notes response has no pagination flag",
      );
    }
    return {
      children: value["mod_notes"],
      cursor: value["has_next_page"] ? cursorFrom(value["end_cursor"]) : null,
    };
  },
};

/** A single-use lazy listing that requests pages only as iteration needs them. */
export class Listing<T = unknown> implements AsyncIterable<T> {
  readonly client: RedditClientLike;
  readonly limit: number | null;
  readonly params: Readonly<Record<string, QueryValue>>;
  readonly url: string;
  readonly requestLimit: number;
  readonly signal: AbortSignal | undefined;
  #objector: Objector;
  #pageAdapter: ListingPageAdapter;
  #started = false;

  constructor(
    client: RedditClientLike,
    url: string,
    options: ListingOptions = {},
  ) {
    const limit = options.limit === undefined ? 100 : options.limit;
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError("limit must be a non-negative integer or null");
    }
    if (
      options.requestLimit !== undefined &&
      (!Number.isInteger(options.requestLimit) || options.requestLimit <= 0)
    ) {
      throw new RangeError("requestLimit must be a positive integer");
    }
    this.client = client;
    this.url = url;
    this.limit = limit;
    this.params = { ...options.params };
    this.requestLimit = options.requestLimit ?? limit ?? 1024;
    this.signal = options.signal;
    this.#objector = options.objector ?? new Objector(client);
    this.#pageAdapter = options.pageAdapter ?? standardPageAdapter;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#started)
      throw new TypeError("A Listing can only be iterated once");
    this.#started = true;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<T> {
    const initialCursor = this.params[this.#pageAdapter.cursorParam];
    let cursor = typeof initialCursor === "string" ? initialCursor : null;
    let yielded = 0;
    while (this.limit === null || yielded < this.limit) {
      this.signal?.throwIfAborted();
      const remaining =
        this.limit === null
          ? this.requestLimit
          : Math.min(this.requestLimit, this.limit - yielded);
      if (remaining === 0) return;
      const requestParams: Record<string, QueryValue> = {
        ...this.params,
        limit: remaining,
      };
      if (cursor !== null)
        requestParams[this.#pageAdapter.cursorParam] = cursor;
      const response = await this.client.request({
        method: "GET",
        path: this.url,
        params: requestParams,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
      const page = this.#pageAdapter.page(response);
      if (page.children.length === 0) return;
      for (const child of page.children) {
        if (this.limit !== null && yielded >= this.limit) return;
        yielded += 1;
        if (this.#pageAdapter.childKind !== undefined && !isRawData(child)) {
          throw new TypeError(
            `Reddit returned invalid ${this.#pageAdapter.childName ?? "listing child"} data`,
          );
        }
        const objectifiable =
          this.#pageAdapter.childKind !== undefined &&
          isRawData(child) &&
          !(typeof child["kind"] === "string" && "data" in child)
            ? { kind: this.#pageAdapter.childKind, data: child }
            : child;
        yield this.#objector.objectify(objectifiable) as T;
      }
      if (page.cursor === null || page.cursor === cursor) return;
      cursor = page.cursor;
    }
  }
}
