import { describe, expect, it, vi } from "vitest";

import { SubredditWiki, createSubredditWiki } from "../src/domains/wiki.js";
import { Redditor, Submission } from "../src/models/entities.js";
import { WikiPage, WikiRevision, wikiPageName } from "../src/models/wiki.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}

describe("standalone wiki domain", () => {
  it("lists, references, creates, reads, and hydrates normalized pages", async () => {
    const signal = new AbortController().signal;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: ["Index", "Guide/Start"] })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        data: {
          content_html: "<p>Hello</p>",
          content_md: "Hello",
          may_revise: true,
          revision_by: { kind: "t2", data: { name: "alice" } },
          revision_date: 123,
        },
      });
    const wiki = new SubredditWiki({ request }, "TypeScript");

    const pages = await wiki.list(signal);
    expect(pages.map((page) => page.name)).toEqual(["index", "guide/start"]);
    expect(wiki.get(" INDEX ")).toBeInstanceOf(WikiPage);
    const created = await wiki.create(
      { content: "Hello", name: "New Page", reason: "initial" },
      signal,
    );
    expect(created.name).toBe("new_page");
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/r/TypeScript/api/wiki/edit",
      data: { content: "Hello", page: "new_page", reason: "initial" },
      signal,
    });
    expect(created.isLoaded).toBe(false);
    await created.read(signal);
    expect(created.isLoaded).toBe(true);
    expect(created.get("content_md")).toBe("Hello");
    expect(created.get("revision_by")).toBeInstanceOf(Redditor);
  });

  it("edits with optimistic revision data and forwards cancellation", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const page = new SubredditWiki({ request }, "test").get("config/sidebar");
    const signal = new AbortController().signal;

    await page.edit("updated", { previous: "rev-old", reason: "sync" }, signal);
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/r/test/api/wiki/edit",
      data: {
        content: "updated",
        page: "config/sidebar",
        previous: "rev-old",
        reason: "sync",
      },
      signal,
    });
    await expect(page.edit("x", { reason: "x".repeat(257) })).rejects.toThrow(
      "256",
    );
  });

  it("hydrates a selected revision and reverts only selected revisions", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { content_md: "old", revision_by: null } })
      .mockResolvedValueOnce(null);
    const page = new SubredditWiki({ request }, "test").get("history");
    const revision = page.revision("abc123");

    await revision.hydrate();
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/r/test/wiki/history",
      params: { v: "abc123" },
    });
    await revision.revert();
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/r/test/api/wiki/revert",
      data: { page: "history", revision: "abc123" },
    });
    await expect(page.revert()).rejects.toThrow("specific wiki revision");
  });

  it("objectifies and paginates page and global revisions", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: "next",
          children: [
            { id: "one", page: "index", author: { data: { name: "alice" } } },
          ],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [{ id: "two", page: "index", author: null }],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [{ id: "global", page: "rules", author: null }],
        },
      });
    const wiki = new SubredditWiki({ request }, "test");
    const revisions = await collect(
      wiki.get("index").revisions({ limit: 2, requestLimit: 1 }),
    );

    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toBeInstanceOf(WikiRevision);
    expect(revisions[0]?.author).toBeInstanceOf(Redditor);
    expect(revisions[0]?.page.revisionId).toBe("one");
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/r/test/wiki/revisions/index",
      params: { after: "next", limit: 1 },
    });
    expect((await collect(wiki.revisions({ limit: 1 })))[0]).toBeInstanceOf(
      WikiRevision,
    );
  });

  it("provides discussion listings and page editor management", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [{ kind: "t3", data: { id: "post", title: "Wiki link" } }],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [{ kind: "t2", data: { name: "editor", link_karma: 1 } }],
        },
      })
      .mockResolvedValue(null);
    const page = new SubredditWiki({ request }, "test").get("help");

    expect((await collect(page.discussions({ limit: 1 })))[0]).toBeInstanceOf(
      Submission,
    );
    expect((await collect(page.editors.list({ limit: 1 })))[0]).toBeInstanceOf(
      Redditor,
    );
    await page.mod.add("alice");
    await page.editors.remove("alice");
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "POST",
      path: "/r/test/api/wiki/alloweditor/add",
      data: { page: "help", username: "alice" },
    });
    expect(request).toHaveBeenNthCalledWith(4, {
      method: "POST",
      path: "/r/test/api/wiki/alloweditor/del",
      data: { page: "help", username: "alice" },
    });
  });

  it("reads and updates validated page settings", async () => {
    const signal = new AbortController().signal;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { listed: true, permlevel: 0 } })
      .mockResolvedValueOnce({ data: { listed: false, permlevel: 2 } });
    const page = new SubredditWiki({ request }, "test").get("index");

    await expect(page.settings(signal)).resolves.toMatchObject({
      listed: true,
    });
    await expect(
      page.updateSettings({ listed: false, permlevel: 2 }, signal),
    ).resolves.toEqual({ listed: false, permlevel: 2 });
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/r/test/wiki/settings/index",
      data: { listed: false, permlevel: 2 },
      signal,
    });
  });

  it("exposes wiki-wide banned/contributor relationships and enforces auth", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const wiki = new SubredditWiki({ request }, "test");
    await wiki.banned.add("vandal");
    await wiki.contributor.remove("former-editor");
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      path: "/r/test/api/friend/",
      data: { name: "vandal", type: "wikibanned" },
    });

    const readOnly = new SubredditWiki({ request, readOnly: true }, "test");
    await expect(readOnly.create({ content: "x", name: "x" })).rejects.toThrow(
      "read-only",
    );
    await expect(readOnly.get("x").edit("x")).rejects.toThrow("read-only");
    await expect(readOnly.get("x").settings()).rejects.toThrow("read-only");
    expect(() => readOnly.get("x").editors.list()).toThrow("read-only");
  });

  it("rejects malformed responses, invalid names, settings, and aborted work", async () => {
    const request = vi.fn().mockResolvedValue({ data: "invalid" });
    const wiki = new SubredditWiki({ request }, "test");
    await expect(wiki.list()).rejects.toThrow("invalid wiki pages");
    expect(() => wiki.get(" ")).toThrow("cannot be empty");
    await expect(
      wiki.get("x").updateSettings({ listed: true, permlevel: 9 as 2 }),
    ).rejects.toThrow("permlevel");

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(wiki.list(controller.signal)).rejects.toThrow("stop");
  });

  it("supports page aliases, factories, iteration, and direct page envelopes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(["One"])
      .mockResolvedValueOnce(["Two"])
      .mockResolvedValueOnce({ content_md: "direct", revision_by: undefined });
    const wiki = createSubredditWiki({ request }, "type script");

    expect(wiki.page("ONE").name).toBe("one");
    expect((await collect(wiki)).map((page) => page.name)).toEqual(["one"]);
    expect((await wiki.list()).map((page) => page.name)).toEqual(["two"]);
    const page = wiki.get("nested/a b");
    expect(String(page)).toBe("type script/nested/a b");
    await page.load();
    await page.load();
    expect(page.get("content_md")).toBe("direct");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/r/type%20script/wiki/nested/a%20b",
    });
  });

  it("creates against an explicit previous revision without a reason", async () => {
    const request = vi.fn().mockResolvedValue(null);
    await new SubredditWiki({ request }, "test").create({
      content: "replacement",
      name: "Page Name",
      previous: "old-revision",
    });
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/r/test/api/wiki/edit",
      data: {
        content: "replacement",
        page: "page_name",
        previous: "old-revision",
      },
    });
  });

  it("validates wiki names, revisions, edits, and author envelopes", async () => {
    expect(wikiPageName(" New Page ", true)).toBe("new_page");
    expect(() => wikiPageName("x".repeat(513))).toThrow("512");
    expect(() => new WikiPage({ request: vi.fn() }, "test", "x", " ")).toThrow(
      "revision ID cannot be empty",
    );

    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { data: { name: "x", revision_by: { data: { name: "alice" } } } },
      })
      .mockResolvedValueOnce({ data: { data: { name: "x", revision_by: 1 } } });
    const page = new SubredditWiki({ request }, "test").get("x");
    await expect(page.hydrate()).resolves.toBe(page);
    expect(page.get("revision_by")).toBeInstanceOf(Redditor);
    await expect(page.hydrate()).rejects.toThrow("invalid wiki author");
    await expect(page.edit(1 as unknown as string)).rejects.toThrow(
      "content must be a string",
    );
    await expect(page.edit("x", { previous: " " })).rejects.toThrow(
      "revision ID cannot be empty",
    );
    await expect(page.edit("x", { reason: "line\nbreak" })).rejects.toThrow(
      "printable",
    );
  });

  it("covers revision aliases, identities, adapters, and encoded paths", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        children: [{ id: "rev", page: "a/b", author: "bad" }],
        after: null,
      })
      .mockResolvedValueOnce({ children: [], after: 2 })
      .mockResolvedValueOnce(null);
    const page = new SubredditWiki({ request }, "test").get("a/b");
    expect(page.revisionAt("rev").revisionId).toBe("rev");
    expect(page.discussions()).toMatchObject({
      url: "/r/test/wiki/discussions/a/b",
    });
    await expect(collect(page.revisions())).rejects.toThrow(
      "invalid wiki author",
    );
    await expect(collect(page.revisions())).rejects.toThrow("cursor");
    await page.revisionAt("rev").editors.revert();

    expect(
      String(
        new WikiRevision({ request: vi.fn() }, "test", {
          id: "identity",
          page: "index",
          author: null,
        }),
      ),
    ).toBe("identity");
    expect(
      () =>
        new WikiRevision({ request: vi.fn() }, "test", {
          id: "",
          page: "index",
        }),
    ).toThrow("invalid wiki revision");
    await expect(
      collect(
        new SubredditWiki(
          { request: vi.fn().mockResolvedValue({ children: null }) },
          "test",
        ).revisions(),
      ),
    ).rejects.toThrow("no children array");
  });

  it("delegates editor settings aliases and validates malformed settings", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ listed: true, permlevel: 1 })
      .mockResolvedValueOnce({
        json: { data: { listed: false, permlevel: 2 } },
      })
      .mockResolvedValueOnce({ listed: true, permlevel: "1" });
    const page = new WikiPage({ request }, "test", "index", undefined, {
      content_md: "already loaded",
    });
    expect(page.isLoaded).toBe(true);
    await expect(page.editors.settings()).resolves.toMatchObject({
      permlevel: 1,
    });
    await expect(
      page.editors.update({ listed: false, permlevel: 2 }),
    ).resolves.toMatchObject({ listed: false });
    await expect(page.settings()).rejects.toThrow("invalid wiki page settings");
    await expect(
      page.updateSettings({
        listed: "yes" as unknown as boolean,
        permlevel: 1,
      }),
    ).rejects.toThrow("listed must be a boolean");
  });

  it("checks cancellation and authorization for every moderator operation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel wiki"));
    const request = vi.fn();
    const wiki = new SubredditWiki({ request }, "test");
    const page = wiki.get("x").revision("r");
    for (const operation of [
      () => page.edit("x", {}, controller.signal),
      () => page.revert(controller.signal),
      () => page.settings(controller.signal),
      () =>
        page.updateSettings({ listed: true, permlevel: 0 }, controller.signal),
      () => page.editors.add("a", controller.signal),
      () => page.editors.remove("a", controller.signal),
    ]) {
      await expect(operation()).rejects.toThrow("cancel wiki");
    }
    expect(request).not.toHaveBeenCalled();

    const forbidden = new SubredditWiki(
      { request, readOnly: true },
      "test",
    ).get("x");
    await expect(forbidden.revision("r").revert()).rejects.toThrow("read-only");
    await expect(
      forbidden.updateSettings({ listed: true, permlevel: 0 }),
    ).rejects.toThrow("read-only");
    await expect(forbidden.editors.add("a")).rejects.toThrow("read-only");
  });
});
