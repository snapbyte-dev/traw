import { describe, expect, it, vi } from "vitest";

import {
  Announcement,
  createAnnouncementsDomain,
  type AnnouncementsClient,
} from "../src/domains/announcements.js";
import type { RedditRequest } from "../src/models/base.js";

function setup(readOnly = false): {
  client: AnnouncementsClient;
  request: ReturnType<
    typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
  >;
} {
  const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
  request.mockResolvedValue(null);
  return { client: { readOnly, request }, request };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("standalone announcements", () => {
  it("lists objectified announcements and forwards cancellation", async () => {
    const { client, request } = setup();
    const signal = new AbortController().signal;
    request.mockResolvedValue({
      after: null,
      data: [{ id: "ann_one", subject: "Notice" }],
    });

    const domain = createAnnouncementsDomain(client);
    const [announcement] = await collect(domain({ limit: 1, signal }));

    expect(announcement).toBeInstanceOf(Announcement);
    expect(announcement?.fullname).toBe("ann_one");
    expect(String(announcement)).toBe("ann_one");
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/announcements/v1",
      params: { limit: 1 },
      signal,
    });
  });

  it("supports the announcement wrapper alias and explicit request limits", async () => {
    const { client, request } = setup();
    request.mockResolvedValue({
      after: null,
      data: [{ kind: "Announcement", data: { id: "ann_alias" } }],
    });
    const domain = createAnnouncementsDomain(client);
    const listing = domain.list({ limit: null, requestLimit: 7 });
    const [announcement] = await collect(listing);
    expect(announcement).toBeInstanceOf(Announcement);
    expect(listing.requestLimit).toBe(7);
  });

  it("batches selective mutations by 100 and supports model actions", async () => {
    const { client, request } = setup();
    const domain = createAnnouncementsDomain(client);
    const ids = Array.from({ length: 101 }, (_, index) => `ann_${index}`);
    const signal = new AbortController().signal;

    await domain.hide(ids, signal);
    await domain.markRead([new Announcement(client, "ann_read")]);
    await new Announcement(client, { id: "ann_model" }).hide();
    await new Announcement(client, { name: "ann_named" }).markRead();
    await domain.markAllRead(signal);

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/announcements/v1/hide",
      data: { ids: ids.slice(0, 100).join(",") },
      signal,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/announcements/v1/hide",
      data: { ids: "ann_100" },
      signal,
    });
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/api/announcements/v1/read_all",
      signal,
    });
  });

  it("enforces authorization, validation, and pre-request cancellation", async () => {
    const blocked = setup(true);
    const domain = createAnnouncementsDomain(blocked.client);
    expect(() => domain()).toThrow("read-only");
    await expect(domain.hide([])).rejects.toThrow("read-only");

    const { client, request } = setup();
    await expect(
      createAnnouncementsDomain(client).markRead([" "]),
    ).rejects.toThrow("announcement ID cannot be empty");
    expect(() => new Announcement(client, {}).fullname).toThrow(
      "valid identity",
    );
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      createAnnouncementsDomain(client).markAllRead(controller.signal),
    ).rejects.toThrow("stopped");
    expect(request).not.toHaveBeenCalled();
  });
});
