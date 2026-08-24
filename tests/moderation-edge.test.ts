import { describe, expect, it, vi } from "vitest";

import { systemClock } from "../src/core/clock.js";
import { Multireddit } from "../src/domains.js";
import { InboxDomain } from "../src/domains/inbox.js";
import { Listing, moderatorNotesPageAdapter } from "../src/listing.js";
import { FlairTemplates, createSubredditFlair } from "../src/domains/flair.js";
import { createSubredditModNotes } from "../src/domains/mod-notes.js";
import {
  SubredditQuarantine,
  createSubredditModeration,
} from "../src/domains/moderation.js";
import {
  ContributorRelationship,
  createSubredditRelationships,
} from "../src/domains/relationships.js";
import { createSubredditRemovalReasons } from "../src/domains/removal-reasons.js";
import { createSubredditRules } from "../src/domains/rules.js";
import { Subreddit } from "../src/models/entities.js";
import {
  FlairTemplate,
  ModAction,
  ModNote,
  RemovalReason,
  Rule,
  requiredString,
  responseArray,
  responseData,
} from "../src/models/moderation.js";

async function first<T>(source: AsyncIterable<T>): Promise<T | undefined> {
  for await (const item of source) return item;
  return undefined;
}

const emptyListing = {
  kind: "Listing",
  data: { after: null, children: [] },
};

describe("moderation edge contracts", () => {
  it("forwards cancellation through selected inbox messages", async () => {
    const signal = new AbortController().signal;
    const request = vi.fn().mockResolvedValue({
      kind: "Listing",
      data: {
        after: null,
        children: [{ kind: "t4", data: { id: "child", name: "t4_child" } }],
      },
    });
    await new InboxDomain({ readOnly: false, request }).message(
      "t4_child",
      signal,
    );
    expect(request.mock.calls[0]?.[0].signal).toBe(signal);
    request.mockResolvedValue(emptyListing);
    await expect(
      new InboxDomain({ readOnly: false, request })
        .stream({
          continueAfterId: "t4_old",
          pauseAfter: -1,
          signal,
        })
        .next(),
    ).resolves.toMatchObject({ value: null });
  });

  it("normalizes non-error abort reasons", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    await expect(systemClock.sleep(1, controller.signal)).rejects.toMatchObject(
      {
        name: "AbortError",
      },
    );
  });

  it("exposes every queue and moderation stream fetcher", async () => {
    const request = vi.fn().mockResolvedValue(emptyListing);
    const moderation = createSubredditModeration({ request }, "test");
    await first(moderation.edited({ only: "comments" }));
    await first(moderation.reports());
    await first(moderation.spam());
    expect(request.mock.calls.map((call) => String(call[0].path))).toEqual([
      "/r/test/about/edited/",
      "/r/test/about/reports/",
      "/r/test/about/spam/",
    ]);

    const streams = [
      moderation.stream.edited({ pauseAfter: -1 }),
      moderation.stream.modqueue({ pauseAfter: -1 }),
      moderation.stream.reports({ pauseAfter: -1 }),
      moderation.stream.spam({ pauseAfter: -1 }),
      moderation.stream.log({ pauseAfter: -1 }),
    ];
    for (const stream of streams) {
      await expect(stream.next()).resolves.toMatchObject({ value: null });
    }
  });

  it("validates settings responses and supports quarantine opt-out", async () => {
    expect(responseData({ json: { data: { ok: true } } }, "wrapped")).toEqual({
      ok: true,
    });
    expect(responseArray({ data: [{ id: "one" }] }, "items")).toEqual([
      { id: "one" },
    ]);
    expect(() => responseData([], "settings")).toThrow("invalid settings");
    expect(() => responseArray([null], "items")).toThrow("invalid items");

    const request = vi.fn().mockResolvedValue(null);
    await new SubredditQuarantine({ request }, "test").optOut();
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/quarantine_optout",
      data: { sr_name: "test" },
    });
  });

  it("covers optional stream cursors and request signals", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { title: "Test" } })
      .mockResolvedValueOnce(null)
      .mockResolvedValue(emptyListing);
    const moderation = createSubredditModeration({ request }, "test");
    const signal = new AbortController().signal;
    await moderation.settings();
    await moderation.acceptInvite();
    await expect(
      moderation.stream
        .edited({
          continueAfterId: "t3_old",
          pauseAfter: -1,
          signal,
        })
        .next(),
    ).resolves.toMatchObject({ value: null });
    await expect(
      moderation.stream
        .log({
          action: "removecomment",
          continueAfterId: "log_old",
          moderator: "alice",
          pauseAfter: -1,
          signal,
        })
        .next(),
    ).resolves.toMatchObject({ value: null });
    await expect(
      moderation.stream.unmoderated({ pauseAfter: -1 }).next(),
    ).resolves.toMatchObject({ value: null });
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      params: { before: "t3_old", limit: 100 },
      signal,
    });
  });

  it("validates moderation model identities and references", () => {
    const client = { request: vi.fn() };
    expect(String(new Rule(client, "test", "name"))).toBe("name");
    expect(String(new RemovalReason(client, "test", "reason"))).toBe("reason");
    expect(() => String(new ModAction(client, {}))).toThrow("valid identity");
    expect(() => String(new ModNote(client, {}))).toThrow("valid identity");
    expect(() => requiredString(" ", "value")).toThrow("cannot be empty");
  });
});

describe("relationship edge contracts", () => {
  it("covers relationship kinds and optional ban fields", async () => {
    const request = vi.fn().mockResolvedValue(emptyListing);
    const relationships = createSubredditRelationships({ request }, "test");
    await relationships.banned.add("user", {
      banContext: "context",
      banMessage: "message",
      duration: 999,
    });
    await relationships.muted.add("user", { note: "note" });
    await relationships.wikibanned.remove("user");
    await first(relationships.wikicontributor.list());
    await first(relationships.contributor.list());
    expect(request.mock.calls[0]?.[0].data).toMatchObject({
      ban_context: "context",
      ban_message: "message",
    });
    expect(
      () => void relationships.banned.add("user", { duration: 1.5 }),
    ).toThrow("duration");
    expect(
      () => void relationships.banned.add("user", { duration: 1000 }),
    ).toThrow("duration");
  });

  it("covers moderator add, update, remove and both listings", async () => {
    const request = vi.fn().mockResolvedValue(emptyListing);
    const moderator = createSubredditRelationships(
      { request },
      "test",
    ).moderator;
    const signal = new AbortController().signal;
    await first(moderator.list({ redditor: "alice", signal }));
    await first(moderator.invited({ signal }));
    await moderator.add("alice");
    await moderator.update("alice", ["posts"], signal);
    await moderator.remove("alice", signal);
    expect(request.mock.calls[2]?.[0].data.permissions).toBe("all");
    expect(request.mock.calls[3]?.[0].data.type).toBe("moderator");
    expect(request.mock.calls[4]?.[0].data.type).toBe("moderator");
  });

  it("leaves contributor relationships only with subreddit fullnames", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const subreddit = new Subreddit(
      { request },
      {
        display_name: "test",
        name: "t5_test",
      },
    );
    await new ContributorRelationship({ request }, subreddit).leave();
    await new ContributorRelationship({ request }, subreddit).leave(
      new AbortController().signal,
    );
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/leavecontributor",
      data: { id: "t5_test" },
    });
    expect(
      () => void new ContributorRelationship({ request }, "test").leave(),
    ).toThrow("loaded Subreddit");
  });

  it("forwards signals through ordinary relationship mutations", async () => {
    const request = vi.fn().mockResolvedValue(emptyListing);
    const signal = new AbortController().signal;
    const relationships = createSubredditRelationships({ request }, "test");
    await relationships.muted.add("alice", {}, signal);
    await relationships.muted.remove("alice", signal);
    await first(relationships.moderator.list());
    await relationships.moderator.updateInvite("alice", [], signal);
    await relationships.moderator.removeInvite("alice", signal);
    await relationships.moderator.update("alice", []);
    expect(
      request.mock.calls.filter((call) => call[0].signal === signal),
    ).toHaveLength(4);
  });
});

describe("flair edge contracts", () => {
  it("covers full template options, clear, link templates, and signals", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([{ id: "link", flair_text: "Link" }])
      .mockResolvedValue(null);
    const flair = createSubredditFlair({ request }, "test");
    const signal = new AbortController().signal;
    expect((await flair.linkTemplates.list(signal))[0]).toBeInstanceOf(
      FlairTemplate,
    );
    await flair.linkTemplates.add(
      "Link",
      {
        allowableContent: "emoji",
        backgroundColor: "#ffffff",
        cssClass: "link",
        maxEmojis: 0,
        modOnly: true,
        textColor: "light",
        textEditable: false,
      },
      signal,
    );
    await flair.linkTemplates.clear(signal);
    await flair.linkTemplates.reorder([], signal);
    expect(request.mock.calls[1]?.[0].data).toMatchObject({
      flair_type: "LINK_FLAIR",
      max_emojis: 0,
      mod_only: true,
      text_color: "light",
    });
    await expect(flair.templates.add("x", { maxEmojis: -1 })).rejects.toThrow(
      "maxEmojis",
    );
  });

  it("fetches existing template fields and rejects unknown IDs", async () => {
    const existing = {
      id: "one",
      flair_text: "Original",
      allowable_content: "text",
      background_color: "#000000",
      css_class: "old",
      max_emojis: 4,
      mod_only: true,
      text_color: "light",
      text_editable: true,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([]);
    const templates = new FlairTemplates({ request }, "test", false);
    await templates.update("one", { cssClass: "new" });
    expect(request.mock.calls[1]?.[0].data).toEqual({
      allowable_content: "text",
      background_color: "#000000",
      css_class: "new",
      flair_template_id: "one",
      max_emojis: 4,
      mod_only: true,
      text: "Original",
      text_color: "light",
      text_editable: true,
    });
    await expect(templates.update("missing", {})).rejects.toThrow("invalid");
  });

  it("uses safe defaults for incomplete templates and rejects malformed lists", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([{ id: "one", max_emojis: "bad" }])
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const templates = new FlairTemplates({ request }, "test", false);
    await templates.update("one", {});
    expect(request.mock.calls[1]?.[0].data).toMatchObject({
      allowable_content: "all",
      background_color: "",
      css_class: "",
      max_emojis: 10,
      mod_only: false,
      text: "",
      text_color: "dark",
      text_editable: false,
    });
    await expect(templates.add("x", { maxEmojis: 1.5 })).rejects.toThrow(
      "maxEmojis",
    );
    const malformed = new FlairTemplates(
      { request: vi.fn().mockResolvedValue({ nope: [] }) },
      "test",
      false,
    );
    await expect(malformed.list()).rejects.toThrow("invalid flair templates");
  });

  it("configures all flair settings and deletes users", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const flair = createSubredditFlair({ request }, "test");
    const signal = new AbortController().signal;
    await flair.configure(
      {
        enabled: true,
        linkPosition: "right",
        linkSelfAssign: true,
        position: "left",
        selfAssign: false,
      },
      signal,
    );
    await flair.deleteUser("alice", signal);
    await flair.setLink({ fullname: "t3_post" });
    await flair.setUser("bob");
    expect(request.mock.calls[0]?.[0].data).toEqual({
      flair_enabled: true,
      flair_position: "left",
      flair_self_assign_enabled: false,
      link_flair_position: "right",
      link_flair_self_assign_enabled: true,
    });
    expect(request.mock.calls[3]?.[0].data.css_class).toBe("");
  });

  it("forwards signals through template and flair mutations", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{ id: "one", flair_text: "One" }])
      .mockResolvedValue(null);
    const flair = createSubredditFlair({ request }, "test");
    const signal = new AbortController().signal;
    await flair.templates.add("Default", {}, signal);
    await flair.templates.update("one", { text: "One" }, signal);
    await flair.templates.delete("one", signal);
    await flair.templates.clear();
    await flair.configure({});
    await flair.deleteUser("alice");
    expect(
      request.mock.calls.filter((call) => call[0].signal === signal),
    ).toHaveLength(4);
  });
});

describe("mod-note edge contracts", () => {
  it("validates every specialized page shape", () => {
    expect(() => moderatorNotesPageAdapter.page(null)).toThrow(
      "mod_notes array",
    );
    expect(() => moderatorNotesPageAdapter.page({})).toThrow("mod_notes array");
    expect(() => moderatorNotesPageAdapter.page({ mod_notes: [] })).toThrow(
      "pagination flag",
    );
    expect(
      moderatorNotesPageAdapter.page({
        end_cursor: "next",
        has_next_page: true,
        mod_notes: [],
      }),
    ).toEqual({ children: [], cursor: "next" });
    expect(() =>
      moderatorNotesPageAdapter.page({
        end_cursor: 1,
        has_next_page: true,
        mod_notes: [],
      }),
    ).toThrow("cursor");
  });

  it("reports unnamed malformed specialized children", async () => {
    const listing = new Listing(
      { request: vi.fn().mockResolvedValue(null) },
      "/custom",
      {
        pageAdapter: {
          childKind: "custom",
          cursorParam: "after",
          page: () => ({ children: [null], cursor: null }),
        },
      },
    );
    await expect(first(listing)).rejects.toThrow("invalid listing child data");
  });

  it("reads and validates legacy multireddit paths", () => {
    const client = { request: vi.fn() };
    expect(
      new Multireddit(client, { name: "multi", path: "/user/u/m/multi" }).path,
    ).toBe("/user/u/m/multi");
    expect(() => new Multireddit(client, { name: "multi" }).path).toThrow(
      "valid path",
    );
  });

  it("deletes all notes and validates create and delete options", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        end_cursor: null,
        has_next_page: false,
        mod_notes: [{ id: "one" }, { id: "two" }],
      })
      .mockResolvedValue(null);
    const notes = createSubredditModNotes({ request }, "test");
    const signal = new AbortController().signal;
    await notes.delete({ deleteAll: true, redditor: "alice", signal });
    expect(request).toHaveBeenCalledTimes(3);
    await expect(notes.delete({ redditor: "alice" })).rejects.toThrow("noteId");
    await expect(
      notes.create({ note: "x".repeat(251), redditor: "alice" }),
    ).rejects.toThrow("250");
  });

  it("supports null bulk entries and rejects malformed responses", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ mod_notes: [null, { id: "one" }] })
      .mockResolvedValueOnce({ nope: [] });
    const notes = createSubredditModNotes({ request }, "test");
    expect(await notes.bulk(["none", "alice"])).toMatchObject([
      null,
      { id: "one" },
    ]);
    await expect(notes.bulk(["alice"])).rejects.toThrow("bulk mod notes");
  });

  it("rejects non-object notes in otherwise valid bulk responses", async () => {
    const notes = createSubredditModNotes(
      { request: vi.fn().mockResolvedValue({ mod_notes: [42] }) },
      "test",
    );
    await expect(notes.bulk(["alice"])).rejects.toThrow(
      "invalid mod note data",
    );
  });

  it("creates notes for thing objects and forwards signals", async () => {
    const request = vi.fn().mockResolvedValue({ id: "note" });
    const signal = new AbortController().signal;
    const notes = createSubredditModNotes({ request }, "test");
    await notes.create(
      { note: "note", redditor: "alice", thing: { fullname: "t1_comment" } },
      signal,
    );
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/mod/notes",
      data: {
        note: "note",
        reddit_id: "t1_comment",
        subreddit: "test",
        user: "alice",
      },
      signal,
    });
  });

  it("unwraps note responses and rejects null create responses", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ json: { data: { id: "wrapped" } } })
      .mockResolvedValueOnce(null);
    const notes = createSubredditModNotes({ request }, "test");
    expect(
      String(await notes.create({ note: "note", redditor: "alice" })),
    ).toBe("wrapped");
    await expect(
      notes.create({ note: "note", redditor: "alice" }),
    ).rejects.toThrow("invalid mod note");
  });

  it("covers explicit note page sizing and no-signal bulk deletion", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        end_cursor: null,
        has_next_page: false,
        mod_notes: [{ id: "one" }],
      })
      .mockResolvedValue(null);
    const notes = createSubredditModNotes({ request }, "test");
    await first(notes.list({ redditor: "alice", requestLimit: 7 }));
    request.mockClear();
    request.mockResolvedValueOnce({
      end_cursor: null,
      has_next_page: false,
      mod_notes: [{ id: "one" }],
    });
    request.mockResolvedValue(null);
    await notes.delete({ deleteAll: true, redditor: "alice" });
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("signal");
  });
});

describe("rule edge contracts", () => {
  it("lists, references, and fully updates rules", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ rules: [{ short_name: "Old", kind: "all" }] })
      .mockResolvedValueOnce([
        {
          short_name: "New",
          description: "new",
          kind: "link",
          violation_reason: "reason",
        },
      ]);
    const rules = createSubredditRules({ request }, "test");
    expect(rules.get("Old")).toBeInstanceOf(Rule);
    expect(await rules.list()).toHaveLength(1);
    const updated = await rules.update(
      "Old",
      {
        description: "new",
        kind: "link",
        shortName: "New",
        violationReason: "reason",
      },
      new AbortController().signal,
    );
    expect(String(updated)).toBe("New");
  });

  it("fills partial rule updates and validates malformed/order responses", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([
        {
          short_name: "Old",
          description: "description",
          kind: "all",
          violation_reason: "violation",
        },
      ])
      .mockResolvedValueOnce([{ short_name: "Old", kind: "all" }]);
    const rules = createSubredditRules({ request }, "test");
    await rules.update("Old", { description: "changed" });
    expect(request.mock.calls[1]?.[0].data).toMatchObject({
      description: "changed",
      kind: "all",
      short_name: "Old",
      violation_reason: "violation",
    });
    await expect(rules.reorder(["same", "same"])).rejects.toThrow("duplicates");

    const invalid = createSubredditRules(
      { request: vi.fn().mockResolvedValue({ rules: "bad" }) },
      "test",
    );
    await expect(invalid.list()).rejects.toThrow("invalid subreddit rules");
  });

  it("forwards signals through rule operations and accepts Rule instances", async () => {
    const responseRule = {
      short_name: "Old",
      description: "description",
      kind: "all",
      violation_reason: "violation",
    };
    const request = vi.fn().mockResolvedValue([responseRule]);
    const rules = createSubredditRules({ request }, "test");
    const signal = new AbortController().signal;
    const rule = new Rule({ request }, "test", responseRule);
    await rules.list(signal);
    await rules.add({ kind: "all", shortName: "Old" }, signal);
    await rules.update(rule, {
      description: "description",
      kind: "all",
      shortName: "Old",
      violationReason: "violation",
    });
    await rules.reorder([rule], signal);
    await rules.delete(rule, signal);
    expect(
      request.mock.calls.filter((call) => call[0].signal === signal),
    ).toHaveLength(4);
  });

  it("rejects missing and incomplete rules during partial updates", async () => {
    const missing = createSubredditRules(
      { request: vi.fn().mockResolvedValue([]) },
      "test",
    );
    await expect(missing.update("missing", {})).rejects.toThrow(
      "does not have rule",
    );
    const incomplete = createSubredditRules(
      { request: vi.fn().mockResolvedValue([{ short_name: "Old" }]) },
      "test",
    );
    await expect(incomplete.update("Old", {})).rejects.toThrow(
      "no valid description",
    );
    const noRule = createSubredditRules(
      { request: vi.fn().mockResolvedValue([]) },
      "test",
    );
    await expect(noRule.add({ kind: "all", shortName: "New" })).rejects.toThrow(
      "no subreddit rule",
    );
  });
});

describe("removal-reason edge contracts", () => {
  it("fills partial updates from existing removal reasons", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { one: { id: "one", message: "message", title: "title" } },
        order: ["one"],
      })
      .mockResolvedValue(null);
    const reasons = createSubredditRemovalReasons({ request }, "test");
    expect(reasons.get("one")).toBeInstanceOf(RemovalReason);
    await reasons.update(
      "one",
      { title: "changed" },
      new AbortController().signal,
    );
    expect(request.mock.calls[1]?.[0].data).toEqual({
      message: "message",
      title: "changed",
    });
  });

  it("rejects malformed lists, entries, and add IDs", async () => {
    const malformed = createSubredditRemovalReasons(
      { request: vi.fn().mockResolvedValue(null) },
      "test",
    );
    await expect(malformed.list()).rejects.toThrow("invalid removal reasons");
    const entry = createSubredditRemovalReasons(
      { request: vi.fn().mockResolvedValue({ data: {}, order: [1] }) },
      "test",
    );
    await expect(entry.list()).rejects.toThrow("invalid removal reason data");
    const add = createSubredditRemovalReasons(
      { request: vi.fn().mockResolvedValue({ id: "bad" }) },
      "test",
    );
    await expect(
      add.add({ message: "message", title: "title" }),
    ).rejects.toThrow("invalid removal reason ID");
  });

  it("rejects incomplete fetched removal reasons", async () => {
    const reasons = createSubredditRemovalReasons(
      {
        request: vi.fn().mockResolvedValue({
          data: { one: { id: "one" } },
          order: ["one"],
        }),
      },
      "test",
    );
    await expect(reasons.update("one", {})).rejects.toThrow("incomplete data");
  });

  it("forwards signals through removal-reason mutations", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce("one")
      .mockResolvedValue(null);
    const reasons = createSubredditRemovalReasons({ request }, "test");
    const signal = new AbortController().signal;
    await reasons.add({ message: "message", title: "title" }, signal);
    await reasons.delete("one", signal);
    expect(request.mock.calls.every((call) => call[0].signal === signal)).toBe(
      true,
    );
  });

  it("rejects partial updates for missing removal reasons", async () => {
    const reasons = createSubredditRemovalReasons(
      { request: vi.fn().mockResolvedValue({ data: {}, order: [] }) },
      "test",
    );
    await expect(reasons.update("missing", {})).rejects.toThrow(
      "does not have removal reason",
    );
  });

  it("fills a missing title while preserving a supplied message", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { one: { id: "one", message: "old", title: "title" } },
        order: ["one"],
      })
      .mockResolvedValue(null);
    const reasons = createSubredditRemovalReasons({ request }, "test");
    await reasons.update("one", { message: "new" });
    expect(request.mock.calls[1]?.[0].data).toEqual({
      message: "new",
      title: "title",
    });
  });
});
