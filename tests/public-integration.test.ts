import { describe, expect, it, vi } from "vitest";

import {
  AccountDomain,
  Announcement,
  Collection,
  Draft,
  Emoji,
  InboxDomain,
  LegacyModmailDomain,
  Message,
  ModmailDomain,
  Multireddit,
  Reddit,
  RedditorModNotes,
  Stylesheet,
  SubredditCollections,
  SubredditEmoji,
  SubredditFlair,
  SubredditModNotes,
  SubredditModeration,
  SubredditQuarantine,
  SubredditRemovalReasons,
  SubredditRules,
  SubredditStylesheet,
  SubredditWidgets,
  SubredditWiki,
  WikiPage,
  LiveThread,
} from "../src/index.js";
import { Config } from "../src/config.js";
import type {
  TransportRequest,
  TransportResponse,
} from "../src/core/transport.js";

function response(value: unknown): TransportResponse {
  const body = JSON.stringify(value);
  return {
    body,
    headers: {},
    json: () => JSON.parse(body) as unknown,
    status: 200,
    statusText: "OK",
    text: () => body,
    url: "https://oauth.reddit.com/test",
  };
}

function setupClient(values: unknown[]): {
  readonly reddit: Reddit;
  readonly send: ReturnType<
    typeof vi.fn<(request: TransportRequest) => Promise<TransportResponse>>
  >;
} {
  const send = vi.fn<(request: TransportRequest) => Promise<TransportResponse>>(
    async () => response(values.shift()),
  );
  return {
    reddit: new Reddit(
      new Config(
        { clientId: "client", clientSecret: "secret", userAgent: "traw:test" },
        {},
      ),
      { send },
      {
        headers: () => ({ "User-Agent": "traw:test" }),
        invalidate: () => undefined,
        readOnly: false,
      },
    ),
    send,
  };
}

function setup(values: unknown[]): Reddit {
  return setupClient(values).reddit;
}

async function first<T>(source: AsyncIterable<T>): Promise<T | undefined> {
  for await (const item of source) return item;
  return undefined;
}

describe("public standalone domain integration", () => {
  it("exposes complete account, announcement, draft, and inbox workflows", async () => {
    const reddit = setup([
      { kind: "t2", data: { id: "me", name: "alice", link_karma: 1 } },
      { after: null, data: [{ id: "notice", subject: "Notice" }] },
      { drafts: [{ id: "draft", kind: "markdown", body: "Body" }] },
      {
        kind: "Listing",
        data: {
          after: null,
          children: [{ kind: "t4", data: { id: "message", subject: "Hello" } }],
        },
      },
    ]);

    expect(reddit.account).toBeInstanceOf(AccountDomain);
    expect(reddit.user).toBe(reddit.account);
    expect(reddit.inbox).toBeInstanceOf(InboxDomain);
    await expect(reddit.account.me()).resolves.toMatchObject({ name: "alice" });
    await expect(
      first(reddit.announcements({ limit: 1 })),
    ).resolves.toBeInstanceOf(Announcement);
    await expect(reddit.drafts.list()).resolves.toEqual([expect.any(Draft)]);
    await expect(
      first(reddit.inbox.messages({ limit: 1 })),
    ).resolves.toBeInstanceOf(Message);
  });

  it("constructs every subreddit-scoped standalone helper", () => {
    const subreddit = setup([]).subreddit("typescript");

    expect(subreddit.moderation).toBeInstanceOf(SubredditModeration);
    expect(subreddit.quarantine).toBeInstanceOf(SubredditQuarantine);
    expect(subreddit.banned).toBe(subreddit.relationships.banned);
    expect(subreddit.contributor).toBe(subreddit.relationships.contributor);
    expect(subreddit.moderator).toBe(subreddit.relationships.moderator);
    expect(subreddit.muted).toBe(subreddit.relationships.muted);
    expect(subreddit.wikibanned).toBe(subreddit.relationships.wikibanned);
    expect(subreddit.wikicontributor).toBe(
      subreddit.relationships.wikicontributor,
    );
    expect(subreddit.flair).toBeInstanceOf(SubredditFlair);
    expect(subreddit.modNotes).toBeInstanceOf(SubredditModNotes);
    expect(subreddit.moderation.notes).toBe(subreddit.modNotes);
    expect(subreddit.rules).toBeInstanceOf(SubredditRules);
    expect(subreddit.removalReasons).toBeInstanceOf(SubredditRemovalReasons);
    expect(subreddit.modmail).toBeInstanceOf(ModmailDomain);
    expect(subreddit.legacyModmail).toBeInstanceOf(LegacyModmailDomain);
    expect(subreddit.wiki).toBeInstanceOf(SubredditWiki);
    expect(subreddit.emoji).toBeInstanceOf(SubredditEmoji);
    expect(subreddit.stylesheet).toBeInstanceOf(SubredditStylesheet);
    expect(subreddit.widgets).toBeInstanceOf(SubredditWidgets);
    expect(subreddit.collections).toBeInstanceOf(SubredditCollections);
  });

  it("attaches site-wide and redditor moderator-note helpers", () => {
    const reddit = setup([]);

    expect(reddit.notes.list).toBeTypeOf("function");
    expect(reddit.redditor("alice").notes).toBeInstanceOf(RedditorModNotes);
  });

  it("reaches scoped domains through the public facade and sends core requests", async () => {
    const { reddit, send } = setupClient([
      { data: { content_md: "# Index" } },
      {
        t5_typescript: {
          party: {
            mod_flair_only: false,
            post_flair_allowed: true,
            url: "https://example.com/party.png",
            user_flair_allowed: true,
          },
        },
      },
      { images: [], stylesheet: ".link { color: red; }" },
      {
        items: {
          identity: { id: "identity", kind: "id-card" },
          moderators: { id: "moderators", kind: "moderators", mods: [] },
        },
        layout: {
          idCardWidget: "identity",
          moderatorWidget: "moderators",
          sidebar: { order: [] },
          topbar: { order: [] },
        },
      },
      { data: { collection_id: "collection", sorted_links: [] } },
    ]);
    const subreddit = reddit.subreddit("typescript");

    await expect(subreddit.wiki.get("index").read()).resolves.toBeInstanceOf(
      WikiPage,
    );
    await expect(subreddit.emoji.list()).resolves.toEqual([expect.any(Emoji)]);
    await expect(subreddit.stylesheet.read()).resolves.toBeInstanceOf(
      Stylesheet,
    );
    await expect(subreddit.widgets.fetch()).resolves.toBe(subreddit.widgets);
    await expect(
      subreddit.collections.get("collection").refresh(),
    ).resolves.toBeInstanceOf(Collection);

    expect(
      send.mock.calls.map(([request]) => new URL(request.url).pathname),
    ).toEqual([
      "/r/typescript/wiki/index",
      "/api/v1/typescript/emojis/all",
      "/r/typescript/about/stylesheet/",
      "/r/typescript/api/widgets",
      "/api/v1/collections/collection",
    ]);
  });

  it("uses full lifecycle live and multireddit domains on Reddit", async () => {
    const { reddit, send } = setupClient([
      { data: { id: "incident", title: "Incident" } },
      { json: { data: { id: "created", title: "Created" }, errors: [] } },
      {
        kind: "Listing",
        data: {
          children: [{ kind: "LiveThread", data: { id: "listed" } }],
        },
      },
      { kind: "LiveThread", data: { id: "featured" } },
      {
        kind: "LabeledMulti",
        data: { name: "dev", path: "/user/alice/m/dev", subreddits: [] },
      },
      [
        {
          kind: "LabeledMulti",
          data: { name: "mine", path: "/user/alice/m/mine" },
        },
      ],
    ]);
    const live = reddit.live("incident");
    const multireddit = reddit.multireddit("alice", "dev");
    const signal = new AbortController().signal;

    await expect(live.load()).resolves.toBe(live);
    await expect(
      reddit.live.create("Created", {}, signal),
    ).resolves.toBeInstanceOf(LiveThread);
    await expect(first(reddit.live.info(["listed"]))).resolves.toBeInstanceOf(
      LiveThread,
    );
    await expect(reddit.live.now()).resolves.toBeInstanceOf(LiveThread);
    await expect(multireddit.load()).resolves.toBe(multireddit);
    await expect(reddit.multireddit.mine()).resolves.toEqual([
      expect.any(Multireddit),
    ]);
    expect(live).toBeInstanceOf(LiveThread);
    expect(multireddit).toBeInstanceOf(Multireddit);
    expect(typeof reddit.multireddit.create).toBe("function");
    expect(
      send.mock.calls.map(([request]) => new URL(request.url).pathname),
    ).toEqual([
      "/api/live/incident/about/",
      "/api/live/create",
      "/api/live/by_id/listed",
      "/api/live/happening_now",
      "/api/multi/user/alice/m/dev/",
      "/api/multi/mine/",
    ]);
  });
});
