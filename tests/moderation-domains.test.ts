import { describe, expect, it, vi } from "vitest";

import { SubredditFlair } from "../src/domains/flair.js";
import { SubredditModNotes, bulkModNotes } from "../src/domains/mod-notes.js";
import {
  SubredditModeration,
  SubredditQuarantine,
} from "../src/domains/moderation.js";
import { createSubredditRelationships } from "../src/domains/relationships.js";
import { SubredditRemovalReasons } from "../src/domains/removal-reasons.js";
import { SubredditRules } from "../src/domains/rules.js";
import { FlairTemplate, ModAction, ModNote } from "../src/models/moderation.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("standalone moderation domains", () => {
  it("constructs queues and sends strict queue and log parameters", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [{ kind: "t3", data: { id: "post", title: "Post" } }],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [
            { kind: "modaction", data: { id: "log", action: "banuser" } },
          ],
        },
      });
    const moderation = new SubredditModeration({ request }, "typescript");

    await collect(moderation.modqueue({ limit: 1, only: "submissions" }));
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/r/typescript/about/modqueue/",
      params: { limit: 1, only: "links" },
    });
    const [action] = await collect(
      moderation.log({ action: "banuser", moderator: "alice", limit: 1 }),
    );
    expect(action).toBeInstanceOf(ModAction);
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/r/typescript/about/log/",
      params: { limit: 1, mod: "alice", type: "banuser" },
    });
  });

  it("loads settings, accepts invites, updates quarantine, and authorizes", async () => {
    const request = vi.fn().mockResolvedValue({ data: { title: "Community" } });
    const client = { request };
    const signal = new AbortController().signal;
    const moderation = new SubredditModeration(client, "test");

    await expect(moderation.settings(signal)).resolves.toEqual({
      title: "Community",
    });
    await moderation.acceptInvite(signal);
    await new SubredditQuarantine(client, "test").optIn(signal);
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "POST",
      path: "/api/quarantine_optin",
      data: { sr_name: "test" },
      signal,
    });
    expect(() =>
      new SubredditModeration({ request, readOnly: true }, "test").spam(),
    ).toThrow("read-only");
  });

  it("builds stream fetches with before cursors and cancellation", async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue({
      kind: "Listing",
      data: {
        after: null,
        children: [{ kind: "t3", data: { id: "new", title: "New" } }],
      },
    });
    const stream = new SubredditModeration(
      { request },
      "test",
    ).stream.unmoderated({
      continueAfterId: "t3_old",
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/r/test/about/unmoderated/",
      params: { before: "t3_old", limit: 100 },
      signal: controller.signal,
    });
    controller.abort(new Error("stop"));
    await iterator.return(undefined);
  });
});

describe("relationships", () => {
  it("lists, adds and removes relationships with API field names", async () => {
    const request = vi.fn().mockResolvedValue({
      kind: "Listing",
      data: { after: null, children: [] },
    });
    const relationships = createSubredditRelationships({ request }, "test");
    await collect(relationships.banned.list({ redditor: "spammer", limit: 1 }));
    await relationships.banned.add("spammer", {
      banReason: "spam",
      duration: 7,
      note: "repeat offender",
    });
    await relationships.banned.remove("spammer");

    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/r/test/api/friend/",
      data: {
        ban_reason: "spam",
        duration: 7,
        name: "spammer",
        note: "repeat offender",
        type: "banned",
      },
    });
    expect(() => relationships.banned.add("spammer", { duration: 0 })).toThrow(
      "duration",
    );
  });

  it("encodes moderator permissions for invite, update, and removal", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const moderator = createSubredditRelationships(
      { request },
      "test",
    ).moderator;
    const signal = new AbortController().signal;

    await moderator.invite("alice", ["posts", "flair"], signal);
    await moderator.updateInvite("alice", []);
    await moderator.removeInvite("alice");
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/r/test/api/friend/",
      data: {
        name: "alice",
        permissions: "posts,flair",
        type: "moderator_invite",
      },
      signal,
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      path: "/r/test/api/setpermissions/",
      data: { permissions: "", type: "moderator_invite" },
    });
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      path: "/r/test/api/unfriend/",
      data: { name: "alice", type: "moderator_invite" },
    });
  });
});

describe("flair", () => {
  it("sets user and link flair and rejects conflicting selectors", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const flair = new SubredditFlair({ request }, "test");
    const signal = new AbortController().signal;

    await flair.setUser(
      "alice",
      { cssClass: "helper", text: "Helpful" },
      signal,
    );
    await flair.setLink("t3_post", { templateId: "template" });
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/r/test/api/flair/",
      data: { css_class: "helper", name: "alice", text: "Helpful" },
      signal,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/r/test/api/selectflair/",
      data: { flair_template_id: "template", link: "t3_post", text: "" },
    });
    expect(() =>
      flair.setUser("alice", { cssClass: "x", templateId: "y" }),
    ).toThrow("cannot be used");
  });

  it("lists, creates, updates, deletes and reorders templates", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "one",
          flair_text: "Old",
          allowable_content: "all",
          text_color: "dark",
        },
      ])
      .mockResolvedValue(null);
    const templates = new SubredditFlair({ request }, "test").templates;
    const [template] = await templates.list();
    expect(template).toBeInstanceOf(FlairTemplate);
    await templates.add("New", { textEditable: true });
    await templates.update("one", { fetch: false, text: "Changed" });
    await templates.delete("one");
    await templates.reorder(["one", "two"]);

    expect(request.mock.calls[1]?.[0]).toMatchObject({
      path: "/r/test/api/flairtemplate_v2",
      data: { flair_type: "USER_FLAIR", text: "New", text_editable: true },
    });
    expect(request).toHaveBeenLastCalledWith({
      method: "PATCH",
      path: "/r/test/api/flair_template_order",
      params: { flair_type: "USER_FLAIR", subreddit: "test" },
      json: ["one", "two"],
    });
  });
});

describe("mod notes", () => {
  it("uses before pagination and create/delete payloads", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        end_cursor: null,
        has_next_page: false,
        mod_notes: [{ id: "note-one", note: "Warning" }],
      })
      .mockResolvedValueOnce({ id: "note-two", note: "Helpful" })
      .mockResolvedValue(null);
    const notes = new SubredditModNotes({ request }, "test");
    expect(
      (await collect(notes.list({ redditor: "alice", limit: 1 })))[0],
    ).toBeInstanceOf(ModNote);
    const created = await notes.create({
      label: "HELPFUL_USER",
      note: "Helpful",
      redditor: "alice",
      thing: "t3_post",
    });
    expect(String(created)).toBe("note-two");
    await notes.delete({ noteId: "note-two", redditor: "alice" });
    expect(request).toHaveBeenLastCalledWith({
      method: "DELETE",
      path: "/api/mod/notes",
      params: { note_id: "note-two", subreddit: "test", user: "alice" },
    });
  });

  it("chunks bulk note requests at 500 and forwards cancellation", async () => {
    const request = vi.fn().mockResolvedValue({ mod_notes: [] });
    const pairs = Array.from({ length: 501 }, (_, index) => ({
      redditor: `user${index}`,
      subreddit: "test",
    }));
    const signal = new AbortController().signal;
    await bulkModNotes({ request }, pairs, signal);
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      String(request.mock.calls[0]?.[0].params.users).split(","),
    ).toHaveLength(500);
    expect(request.mock.calls[0]?.[0].signal).toBe(signal);
  });
});

describe("rules and removal reasons", () => {
  it("sends rule CRUD and encoded reorder payloads", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([{ short_name: "No spam", kind: "all" }])
      .mockResolvedValueOnce([
        { short_name: "No spam", kind: "all" },
        { short_name: "Be nice", kind: "comment" },
      ])
      .mockResolvedValue(null);
    const rules = new SubredditRules({ request }, "test");
    await rules.add({ kind: "all", shortName: "No spam" });
    await rules.reorder(["No spam", "Be nice"]);
    await rules.delete("No spam");

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/add_subreddit_rule",
      data: {
        description: "",
        kind: "all",
        r: "test",
        short_name: "No spam",
        violation_reason: "No spam",
      },
    });
    expect(request.mock.calls[1]?.[0].data.new_rule_order).toBe(
      "No%20spam,Be%20nice",
    );
  });

  it("orders removal reasons and sends add/update/delete requests", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          second: { id: "second", message: "B", title: "Second" },
          first: { id: "first", message: "A", title: "First" },
        },
        order: ["first", "second"],
      })
      .mockResolvedValueOnce("third")
      .mockResolvedValue(null);
    const reasons = new SubredditRemovalReasons({ request }, "test");
    expect((await reasons.list()).map(String)).toEqual(["first", "second"]);
    expect(String(await reasons.add({ message: "C", title: "Third" }))).toBe(
      "third",
    );
    await reasons.update("third", { message: "Updated", title: "Updated" });
    await reasons.delete("third");
    expect(request.mock.calls[2]?.[0]).toEqual({
      method: "PUT",
      path: "/api/v1/test/removal_reasons/third",
      data: { message: "Updated", title: "Updated" },
    });
    expect(request.mock.calls[3]?.[0]).toEqual({
      method: "DELETE",
      path: "/api/v1/test/removal_reasons/third",
    });
  });
});
