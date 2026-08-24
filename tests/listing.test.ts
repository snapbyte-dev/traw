import { describe, expect, it, vi } from "vitest";

import {
  announcementsPageAdapter,
  Listing,
  moderatorNotesPageAdapter,
} from "../src/listing.js";
import { Submission } from "../src/models/entities.js";
import { Objector } from "../src/objector.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe("Listing", () => {
  it("preserves caller params, forwards cursors, and enforces the total limit", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: "next",
          children: [
            { kind: "t3", data: { id: "a", title: "A" } },
            { kind: "t3", data: { id: "b", title: "B" } },
          ],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [
            { kind: "t3", data: { id: "c", title: "C" } },
            { kind: "t3", data: { id: "ignored", title: "Ignored" } },
          ],
        },
      });
    const params = { sort: "new" } as const;
    const values = await collect(
      new Listing<Submission>({ request }, "/new", {
        limit: 3,
        params,
        requestLimit: 2,
      }),
    );

    expect(values.map(String)).toEqual(["a", "b", "c"]);
    expect(values.every((value) => value instanceof Submission)).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/new",
      params: { limit: 2, sort: "new" },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/new",
      params: { after: "next", limit: 1, sort: "new" },
    });
    expect(params).toEqual({ sort: "new" });
  });

  it.each([-1, 1.5, Number.NaN])("rejects invalid limit %s", (limit) => {
    expect(() => new Listing({ request: vi.fn() }, "/new", { limit })).toThrow(
      "limit must be a non-negative integer or null",
    );
  });

  it.each([0, -1, 1.5])("rejects invalid requestLimit %s", (requestLimit) => {
    expect(
      () => new Listing({ request: vi.fn() }, "/new", { requestLimit }),
    ).toThrow("requestLimit must be a positive integer");
  });

  it("does not request for a zero limit and cannot be iterated twice", async () => {
    const request = vi.fn();
    const listing = new Listing({ request }, "/new", { limit: 0 });
    expect(await collect(listing)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(() => listing[Symbol.asyncIterator]()).toThrow(
      "A Listing can only be iterated once",
    );
  });

  it("supports unlimited listings, direct data shapes, and the default request size", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ after: "cursor", children: ["a"] })
      .mockResolvedValueOnce({ after: undefined, children: ["b"] });
    expect(
      await collect(new Listing<string>({ request }, "/all", { limit: null })),
    ).toEqual(["a", "b"]);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      params: { limit: 1024 },
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      params: { after: "cursor", limit: 1024 },
    });
  });

  it("adapts announcement pages and objectifies their raw children", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        after: "ann_cursor",
        before: null,
        data: [{ id: "ann_1", subject: "First" }],
      })
      .mockResolvedValueOnce({
        after: null,
        before: "ann_cursor",
        data: [{ id: "ann_2", subject: "Second" }],
      });
    const objector = new Objector(
      { request },
      {
        ann: (_client, data) => data["id"],
      },
    );

    await expect(
      collect(
        new Listing<string>({ request }, "/announcements", {
          limit: null,
          objector,
          pageAdapter: announcementsPageAdapter,
          requestLimit: 100,
        }),
      ),
    ).resolves.toEqual(["ann_1", "ann_2"]);
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/announcements",
      params: { after: "ann_cursor", limit: 100 },
    });
  });

  it("adapts moderator-note pages and sends end_cursor as before", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        end_cursor: "note_cursor",
        has_next_page: true,
        mod_notes: [{ id: "note_1", note: "First" }],
      })
      .mockResolvedValueOnce({
        end_cursor: null,
        has_next_page: false,
        mod_notes: [{ id: "note_2", note: "Second" }],
      });
    const objector = new Objector(
      { request },
      {
        mod_note: (_client, data) => data["id"],
      },
    );

    await expect(
      collect(
        new Listing<string>({ request }, "/mod/notes", {
          limit: null,
          objector,
          pageAdapter: moderatorNotesPageAdapter,
          requestLimit: 100,
        }),
      ),
    ).resolves.toEqual(["note_1", "note_2"]);
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/mod/notes",
      params: { before: "note_cursor", limit: 100 },
    });
  });

  it("stops on an empty page or a repeated cursor", async () => {
    const emptyRequest = vi
      .fn()
      .mockResolvedValue({ after: "unused", children: [] });
    expect(
      await collect(new Listing({ request: emptyRequest }, "/new")),
    ).toEqual([]);

    const repeatedRequest = vi
      .fn()
      .mockResolvedValueOnce({ after: "same", children: [1] })
      .mockResolvedValueOnce({ after: "same", children: [2] });
    expect(
      await collect(new Listing<number>({ request: repeatedRequest }, "/new")),
    ).toEqual([1, 2]);
    expect(repeatedRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    [null, "Reddit listing response has no children array"],
    [
      { kind: "Listing", data: {} },
      "Reddit listing response has no children array",
    ],
    [
      { children: [], after: 42 },
      "Reddit listing cursor must be a string or null",
    ],
  ])("rejects malformed response %#", async (response, message) => {
    const listing = new Listing(
      { request: vi.fn().mockResolvedValue(response) },
      "/new",
    );
    await expect(collect(listing)).rejects.toThrow(message);
  });

  it("forwards AbortSignal and aborts before subsequent requests", async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue({ after: "next", children: [1] });
    const iterator = new Listing<number>({ request }, "/new", {
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: 1 });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      signal: controller.signal,
    });
    controller.abort(new Error("stop listing"));
    await expect(iterator.next()).rejects.toThrow("stop listing");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
