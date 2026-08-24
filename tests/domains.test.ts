import { describe, expect, it, vi } from "vitest";

import {
  Announcement,
  Draft,
  LiveThread,
  ModNote,
  Multireddit,
  RedditorsDomain,
  SubredditsDomain,
} from "../src/domains.js";
import { Listing } from "../src/listing.js";
import {
  Comment,
  Message,
  Redditor,
  Subreddit,
} from "../src/models/entities.js";
import { Reddit } from "../src/reddit.js";

function client(readOnly = false): Reddit {
  const reddit = Object.create(Reddit.prototype) as Reddit;
  Object.defineProperty(reddit, "readOnly", { value: readOnly });
  return reddit;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("PRAW-like domains", () => {
  it("loads and caches the authenticated user and rejects read-only use", async () => {
    const reddit = client();
    const request = vi
      .fn()
      .mockResolvedValue({ name: "current", link_karma: 1 });
    Object.defineProperty(reddit, "request", { value: request });
    const { UserDomain } = await import("../src/domains.js");
    const user = new UserDomain(reddit);

    await expect(user.me()).resolves.toBeInstanceOf(Redditor);
    await user.me();
    expect(request).toHaveBeenCalledOnce();
    await user.me({ useCache: false });
    expect(request).toHaveBeenCalledTimes(2);
    await expect(new UserDomain(client(true)).me()).rejects.toThrow(
      "read-only",
    );
  });

  it("accepts objectified and wrapped users and rejects invalid user data", async () => {
    const reddit = client();
    const signal = new AbortController().signal;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "t2",
        data: { name: "objectified", link_karma: 1 },
      })
      .mockResolvedValueOnce({ data: { name: "wrapped" } })
      .mockResolvedValueOnce(null);
    Object.defineProperty(reddit, "request", { value: request });
    const { UserDomain } = await import("../src/domains.js");
    const user = new UserDomain(reddit);

    await expect(user.me({ signal })).resolves.toBeInstanceOf(Redditor);
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/api/v1/me",
      signal,
    });
    await expect(user.me({ useCache: false })).resolves.toMatchObject({
      name: "wrapped",
    });
    await expect(user.me({ useCache: false })).rejects.toThrow(
      "invalid user data",
    );
  });

  it("provides inbox listings and batches unread updates by 25", async () => {
    const reddit = client();
    const request = vi.fn().mockResolvedValue({
      kind: "Listing",
      data: {
        after: null,
        children: [{ kind: "t1", data: { id: "reply", parent_id: "t3_post" } }],
      },
    });
    Object.defineProperty(reddit, "request", { value: request });
    const { InboxDomain } = await import("../src/domains.js");
    const inbox = new InboxDomain(reddit);
    const [reply] = await collect(inbox.unread({ limit: 1, markRead: true }));

    expect(reply).toBeInstanceOf(Comment);
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/message/unread/",
      params: { limit: 1, mark: true },
    });
    request.mockClear();
    const fullnames = Array.from({ length: 26 }, (_, index) => `t4_${index}`);
    await inbox.markAllUnread(fullnames);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/unread_message/",
      data: { id: fullnames.slice(0, 25).join(",") },
    });
    await inbox.markAllRead();
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/api/read_all_messages",
    });
  });

  it("provides every inbox view, signals, fullname objects, and read-only errors", async () => {
    const reddit = client();
    const request = vi.fn().mockResolvedValue({
      kind: "Listing",
      data: {
        after: null,
        children: [{ kind: "t4", data: { id: "message", subject: "Hi" } }],
      },
    });
    Object.defineProperty(reddit, "request", { value: request });
    const { InboxDomain } = await import("../src/domains.js");
    const inbox = new InboxDomain(reddit);
    const views = [
      inbox.all(),
      inbox.messages(),
      inbox.commentReplies(),
      inbox.submissionReplies(),
      inbox.mentions(),
      inbox.sent(),
    ];
    expect(views.map((view) => view.url)).toEqual([
      "/message/inbox/",
      "/message/messages/",
      "/message/comments/",
      "/message/selfreply/",
      "/message/mentions",
      "/message/sent/",
    ]);
    expect((await collect(views[1]!))[0]).toBeInstanceOf(Message);

    const signal = new AbortController().signal;
    request.mockClear();
    await inbox.markAllUnread([{ fullname: "t4_one" }], signal);
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/unread_message/",
      data: { id: "t4_one" },
      signal,
    });
    await inbox.markAllUnread([]);
    await inbox.markAllRead(signal);
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/api/read_all_messages",
      signal,
    });
    await expect(inbox.markAllUnread([" "])).rejects.toThrow(
      "fullname cannot be empty",
    );

    const readOnlyInbox = new InboxDomain(client(true));
    await expect(readOnlyInbox.markAllRead()).rejects.toThrow("read-only");
    await expect(readOnlyInbox.markAllUnread([])).rejects.toThrow("read-only");
  });

  it("adapts redditor and subreddit discovery listings", async () => {
    const reddit = client();
    const request = vi.fn().mockResolvedValue({
      kind: "Listing",
      data: {
        after: null,
        children: [{ kind: "t5", data: { display_name: "found" } }],
      },
    });
    Object.defineProperty(reddit, "request", { value: request });
    const { RedditorsDomain, SubredditsDomain } =
      await import("../src/domains.js");

    expect(
      (
        await collect(
          new RedditorsDomain(reddit).search("person", { limit: 1 }),
        )
      )[0],
    ).toBeInstanceOf(Subreddit);
    expect(request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/users/search",
      params: { limit: 1, q: "person" },
    });
    expect(new SubredditsDomain(reddit).default()).toBeInstanceOf(Listing);
    await collect(
      new SubredditsDomain(reddit).search("typescript", { limit: 1 }),
    );
    expect(request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/subreddits/search/",
      params: { limit: 1, q: "typescript" },
    });
  });

  it("creates all discovery listings and validates search queries", () => {
    const reddit = client();
    const redditors = new RedditorsDomain(reddit);
    const subreddits = new SubredditsDomain(reddit);
    expect(redditors.new()).toMatchObject({ url: "/users/new" });
    expect(subreddits.new()).toMatchObject({ url: "/subreddits/new/" });
    expect(subreddits.popular()).toMatchObject({ url: "/subreddits/popular/" });
    expect(() => redditors.search(" ")).toThrow("query cannot be empty");
    expect(() => subreddits.search(" ")).toThrow("query cannot be empty");
  });

  it("lists announcements and notes with their specialized models", async () => {
    const reddit = client();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        after: null,
        before: null,
        data: [{ id: "ann_a1", subject: "A maintenance announcement" }],
      })
      .mockResolvedValueOnce({
        end_cursor: null,
        has_next_page: false,
        mod_notes: [{ id: "n1", note: "Previous warning", subreddit: "test" }],
      });
    Object.defineProperty(reddit, "request", { value: request });
    const { createAnnouncementsDomain, createNotesDomain } =
      await import("../src/domains.js");

    expect(
      (await collect(createAnnouncementsDomain(reddit)({ limit: 1 })))[0],
    ).toBeInstanceOf(Announcement);
    expect(
      (
        await collect(
          createNotesDomain(reddit)({
            subreddit: "test",
            redditor: "mod",
            limit: 1,
          }),
        )
      )[0],
    ).toBeInstanceOf(ModNote);
    expect(request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/api/mod/notes",
      params: { limit: 1, subreddit: "test", user: "mod" },
    });
  });

  it("supports announcement aliases, limits, fallback children, and authorization", async () => {
    const reddit = client();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        after: null,
        before: null,
        data: [{ kind: "Announcement", data: { id: "ann_a2" } }],
      })
      .mockResolvedValueOnce({
        after: null,
        before: null,
        data: "invalid",
      });
    Object.defineProperty(reddit, "request", { value: request });
    const { createAnnouncementsDomain } = await import("../src/domains.js");
    const announcements = createAnnouncementsDomain(reddit);
    const listing = announcements.list({ limit: 500 });
    expect(listing.requestLimit).toBe(100);
    expect((await collect(listing))[0]).toBeInstanceOf(Announcement);
    await expect(collect(announcements({ limit: 1 }))).rejects.toThrow(
      "no data array",
    );
    expect(announcements({ limit: 0 }).requestLimit).toBe(1);
    expect(announcements({ limit: null, requestLimit: 7 }).requestLimit).toBe(
      7,
    );

    const signal = new AbortController().signal;
    await announcements.markAllRead(signal);
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/api/announcements/v1/read_all",
      signal,
    });
    await expect(
      createAnnouncementsDomain(client(true)).markAllRead(),
    ).rejects.toThrow("read-only");
  });

  it("validates announcement model identities and malformed children", async () => {
    const reddit = client();
    expect(new Announcement(reddit, { id: "a", name: "t6_a" }).fullname).toBe(
      "t6_a",
    );
    expect(new Announcement(reddit, "a").fullname).toBe("a");
    expect(() => String(new Announcement(reddit, {}))).toThrow(
      "valid identity",
    );
    const request = vi.fn().mockResolvedValue({
      after: null,
      before: null,
      data: [null],
    });
    Object.defineProperty(reddit, "request", { value: request });
    const { createAnnouncementsDomain } = await import("../src/domains.js");
    await expect(
      collect(createAnnouncementsDomain(reddit)({ limit: 1 })),
    ).rejects.toThrow("invalid announcement data");
  });

  it("lists and creates drafts with validated request data", async () => {
    const reddit = client();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        drafts: [{ id: "old", kind: "markdown", body: "text" }],
      })
      .mockResolvedValueOnce({
        json: {
          errors: [],
          data: { drafts_count: 2, id: "new" },
        },
      });
    Object.defineProperty(reddit, "request", { value: request });
    const { createDraftsDomain } = await import("../src/domains.js");
    const drafts = createDraftsDomain(reddit);

    expect((await drafts())[0]).toBeInstanceOf(Draft);
    await expect(drafts.create({ selftext: "a", url: "b" })).rejects.toThrow(
      "Exactly one",
    );
    const created = await drafts.create({
      title: "Title",
      selftext: "Body",
      subreddit: "test",
    });
    expect(created).toBeInstanceOf(Draft);
    expect(String(created)).toBe("new");
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/api/v1/draft",
      data: {
        body: "Body",
        is_public_link: false,
        kind: "markdown",
        nsfw: false,
        original_content: false,
        send_replies: true,
        spoiler: false,
        subreddit: "test",
        target: "subreddit",
        title: "Title",
      },
    });
  });

  it("supports draft wrappers, references, complete options, and failures", async () => {
    const reddit = client();
    const signal = new AbortController().signal;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { drafts: [{ data: { id: "wrapped" } }] },
      })
      .mockResolvedValueOnce({
        json: {
          errors: [],
          data: { drafts_count: 3, id: "profile" },
        },
      })
      .mockResolvedValueOnce({ id: "link" })
      .mockResolvedValueOnce("invalid");
    Object.defineProperty(reddit, "request", { value: request });
    const { createDraftsDomain } = await import("../src/domains.js");
    const drafts = createDraftsDomain(reddit);

    expect((await drafts.list(signal))[0]).toBeInstanceOf(Draft);
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/api/v1/drafts",
      params: { md_body: true },
      signal,
    });
    expect(String(drafts("existing"))).toBe("existing");
    expect(() => drafts(" ")).toThrow("draft ID cannot be empty");
    await expect(drafts.create({ flairText: "text" })).rejects.toThrow(
      "flairId is required",
    );
    const profileDraft = await drafts.create(
      {
        flairId: "flair",
        flairText: "text",
        isPublicLink: true,
        nsfw: true,
        originalContent: true,
        sendReplies: false,
        spoiler: true,
        subreddit: "u_owner",
        title: "Profile post",
        url: "https://example.com",
      },
      signal,
    );
    expect(profileDraft).toBeInstanceOf(Draft);
    expect(String(profileDraft)).toBe("profile");
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/v1/draft",
      data: {
        body: "https://example.com",
        flair_id: "flair",
        flair_text: "text",
        is_public_link: true,
        kind: "link",
        nsfw: true,
        original_content: true,
        send_replies: false,
        spoiler: true,
        subreddit: "u_owner",
        target: "profile",
        title: "Profile post",
      },
      signal,
    });
    const subreddit = new Subreddit(reddit, {
      display_name: "typescript",
      name: "t5_full",
    });
    await drafts.create({ subreddit });
    expect(request.mock.calls[2]![0].data).toMatchObject({
      subreddit: "typescript",
      target: "subreddit",
    });
    await expect(drafts.create({})).rejects.toThrow("invalid draft data");

    const invalidReddit = client();
    Object.defineProperty(invalidReddit, "request", {
      value: vi.fn().mockResolvedValue({ drafts: "invalid" }),
    });
    await expect(createDraftsDomain(invalidReddit).list()).rejects.toThrow(
      "invalid drafts data",
    );
    await expect(createDraftsDomain(client(true))()).rejects.toThrow(
      "read-only",
    );
    await expect(createDraftsDomain(client(true)).create({})).rejects.toThrow(
      "read-only",
    );
  });

  it("creates live thread and multireddit references", async () => {
    const reddit = client();
    const request = vi.fn().mockResolvedValue({
      json: { errors: [], data: { id: "live1" } },
    });
    Object.defineProperty(reddit, "request", { value: request });
    const { createLiveDomain, createMultiredditDomain } =
      await import("../src/domains.js");
    const live = createLiveDomain(reddit);

    expect(live("existing")).toBeInstanceOf(LiveThread);
    const created = await live.create("News", { description: "Updates" });
    expect(created).toBeInstanceOf(LiveThread);
    expect(String(created)).toBe("live1");
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/live/create",
      data: { description: "Updates", nsfw: false, title: "News" },
    });
    expect(createMultiredditDomain(reddit)("owner", "web dev").path).toBe(
      "/user/owner/m/web%20dev",
    );
  });

  it("supports complete live options and validates live requests", async () => {
    const reddit = client();
    const signal = new AbortController().signal;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        json: { errors: [], data: { id: "live2" } },
      })
      .mockResolvedValueOnce(null);
    Object.defineProperty(reddit, "request", { value: request });
    const { createLiveDomain } = await import("../src/domains.js");
    const live = createLiveDomain(reddit);
    const created = await live.create(
      " Live ",
      { description: "desc", nsfw: true, resources: "links" },
      signal,
    );
    expect(created).toBeInstanceOf(LiveThread);
    expect(String(created)).toBe("live2");
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/live/create",
      data: {
        description: "desc",
        nsfw: true,
        resources: "links",
        title: "Live",
      },
      signal,
    });
    expect(() => live(" ")).toThrow("live thread ID cannot be empty");
    await expect(live.create(" ")).rejects.toThrow("title cannot be empty");
    await expect(live.create("Valid")).rejects.toThrow(
      "invalid live thread data",
    );
    await expect(
      createLiveDomain(client(true)).create("Title"),
    ).rejects.toThrow("read-only");
  });

  it("supports both multireddit overloads and validates identities", async () => {
    const reddit = client();
    const { createMultiredditDomain } = await import("../src/domains.js");
    const multireddit = createMultiredditDomain(reddit);
    const owner = new Redditor(reddit, "some owner");
    expect(multireddit({ redditor: owner, name: "news feed" })).toMatchObject({
      name: "news feed",
      path: "/user/some%20owner/m/news%20feed",
    });
    expect(multireddit(owner, "other")).toBeInstanceOf(Multireddit);
    expect(() => multireddit("owner", undefined as never)).toThrow(
      "name is required",
    );
    expect(() => multireddit(" ", "name")).toThrow("redditor cannot be empty");
    expect(() => multireddit("owner", " ")).toThrow(
      "multireddit name cannot be empty",
    );
    expect(() => new Multireddit(reddit, { name: "x" }).path).toThrow(
      "no valid path",
    );
  });

  it("supports notes aliases, object parameters, and validation", async () => {
    const reddit = client();
    const request = vi.fn().mockResolvedValue({
      end_cursor: null,
      has_next_page: false,
      mod_notes: [{ id: "note", note: "Context for moderators" }],
    });
    Object.defineProperty(reddit, "request", { value: request });
    const { createNotesDomain } = await import("../src/domains.js");
    const notes = createNotesDomain(reddit);
    const signal = new AbortController().signal;
    const listing = notes.list({
      limit: 1,
      params: { before: "cursor" },
      redditor: new Redditor(reddit, "mod"),
      signal,
      subreddit: new Subreddit(reddit, "typescript"),
    });
    expect((await collect(listing))[0]).toBeInstanceOf(ModNote);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/mod/notes",
      params: {
        before: "cursor",
        limit: 1,
        subreddit: "typescript",
        user: "mod",
      },
      signal,
    });
    expect(notes({ redditor: "mod", subreddit: "test" })).toBeInstanceOf(
      Listing,
    );
    expect(() => notes({ redditor: " ", subreddit: "test" })).toThrow(
      "redditor cannot be empty",
    );
    expect(() => notes({ redditor: "mod", subreddit: " " })).toThrow(
      "subreddit cannot be empty",
    );
    expect(() =>
      createNotesDomain(client(true))({ redditor: "mod", subreddit: "test" }),
    ).toThrow("read-only");
  });
});
