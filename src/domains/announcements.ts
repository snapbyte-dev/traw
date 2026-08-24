import { ReadOnlyException } from "../exceptions.js";
import {
  announcementsPageAdapter,
  Listing,
  type ListingOptions,
} from "../listing.js";
import { Objector } from "../objector.js";
import {
  BaseModel,
  type RawData,
  type RedditClientLike,
} from "../models/base.js";
import type { ActionOptions } from "../models/mixins.js";

export interface AnnouncementsClient extends RedditClientLike {
  readonly readOnly: boolean;
}

export type AnnouncementReference = string | { readonly fullname: string };

function assertAuthorized(
  client: AnnouncementsClient,
  operation: string,
): void {
  if (client.readOnly)
    throw new ReadOnlyException(`${operation} does not work in read-only mode`);
}

function announcementId(value: AnnouncementReference): string {
  const id = typeof value === "string" ? value : value.fullname;
  const normalized = id.trim();
  if (normalized.length === 0)
    throw new TypeError("announcement ID cannot be empty");
  return normalized;
}

async function mutate(
  client: AnnouncementsClient,
  operation: string,
  path: string,
  announcements: Iterable<AnnouncementReference>,
  signal?: AbortSignal,
): Promise<void> {
  assertAuthorized(client, operation);
  signal?.throwIfAborted();
  const ids = Array.from(announcements, announcementId);
  for (let index = 0; index < ids.length; index += 100) {
    signal?.throwIfAborted();
    const response = await client.request({
      method: "POST",
      path,
      data: { ids: ids.slice(index, index + 100).join(",") },
      ...(signal === undefined ? {} : { signal }),
    });
    new Objector(client).objectify(response);
  }
}

export class Announcement extends BaseModel {
  constructor(client: AnnouncementsClient, value: string | RawData) {
    super(
      client,
      typeof value === "string" ? { id: announcementId(value) } : value,
    );
  }

  get fullname(): string {
    const name = this.get("name");
    if (typeof name === "string" && name.length > 0) return name;
    const id = this.get("id");
    if (typeof id !== "string" || id.length === 0)
      throw new TypeError("Announcement has no valid identity");
    return id;
  }

  override toString(): string {
    return this.fullname;
  }

  hide(options: ActionOptions = {}): Promise<void> {
    return mutate(
      this.client as AnnouncementsClient,
      "announcement.hide()",
      "/api/announcements/v1/hide",
      [this],
      options.signal,
    );
  }

  markRead(options: ActionOptions = {}): Promise<void> {
    return mutate(
      this.client as AnnouncementsClient,
      "announcement.markRead()",
      "/api/announcements/v1/read",
      [this],
      options.signal,
    );
  }
}

export interface AnnouncementsDomain {
  (options?: ListingOptions): Listing<Announcement>;
  list(options?: ListingOptions): Listing<Announcement>;
  hide(
    announcements: Iterable<AnnouncementReference>,
    signal?: AbortSignal,
  ): Promise<void>;
  markRead(
    announcements: Iterable<AnnouncementReference>,
    signal?: AbortSignal,
  ): Promise<void>;
  markAllRead(signal?: AbortSignal): Promise<void>;
}

export function createAnnouncementsDomain(
  client: AnnouncementsClient,
): AnnouncementsDomain {
  const list = (options: ListingOptions = {}): Listing<Announcement> => {
    assertAuthorized(client, "announcements()");
    const requestLimit =
      options.requestLimit ?? Math.max(1, Math.min(options.limit ?? 100, 100));
    return new Listing(client, "/api/announcements/v1", {
      ...options,
      objector: new Objector(client, {
        ann: (modelClient, data) =>
          new Announcement(modelClient as AnnouncementsClient, data),
        Announcement: (modelClient, data) =>
          new Announcement(modelClient as AnnouncementsClient, data),
      }),
      pageAdapter: announcementsPageAdapter,
      requestLimit,
    });
  };
  return Object.assign(list, {
    list,
    hide: (
      announcements: Iterable<AnnouncementReference>,
      signal?: AbortSignal,
    ) =>
      mutate(
        client,
        "announcements.hide()",
        "/api/announcements/v1/hide",
        announcements,
        signal,
      ),
    markRead: (
      announcements: Iterable<AnnouncementReference>,
      signal?: AbortSignal,
    ) =>
      mutate(
        client,
        "announcements.markRead()",
        "/api/announcements/v1/read",
        announcements,
        signal,
      ),
    async markAllRead(signal?: AbortSignal): Promise<void> {
      assertAuthorized(client, "announcements.markAllRead()");
      signal?.throwIfAborted();
      const response = await client.request({
        method: "POST",
        path: "/api/announcements/v1/read_all",
        ...(signal === undefined ? {} : { signal }),
      });
      new Objector(client).objectify(response);
    },
  });
}
