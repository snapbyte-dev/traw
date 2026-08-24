import { describe, expect, it, vi } from "vitest";

import { LegacyModmailDomain, ModmailDomain } from "../src/domains/modmail.js";
import {
  LegacyModmailMessage,
  ModmailAction,
  ModmailAuthor,
  ModmailConversation,
  ModmailMessage,
  ModmailUser,
  parseModmailAction,
  parseModmailConversation,
  parseModmailMessage,
  type ModmailClient,
} from "../src/models/modmail.js";
import { Subreddit } from "../src/models/entities.js";
import { Objector } from "../src/objector.js";

function client(
  responses: unknown[] = [],
  readOnly = false,
): ModmailClient & {
  request: ReturnType<typeof vi.fn>;
} {
  return {
    readOnly,
    request: vi.fn(async () => responses.shift()),
  };
}

function conversationEnvelope(id = "abc") {
  return {
    conversation: {
      id,
      subject: "Help",
      owner: { displayName: "typescript", id: "2q", type: "t5" },
      participant: { name: "person", isAdmin: false, isDeleted: false },
      authors: [{ name: "mod", isAdmin: false, isDeleted: false, isMod: true }],
      objIds: [
        { key: "messages", id: "m1" },
        { key: "modActions", id: "a1" },
      ],
    },
    messages: {
      m1: {
        id: "m1",
        bodyMarkdown: "Hello",
        isInternal: false,
        author: { name: "person", isAdmin: false, isDeleted: false },
      },
    },
    modActions: {
      a1: {
        id: "a1",
        actionTypeId: 2,
        date: "2024-01-01T00:00:00Z",
        author: { name: "mod", isAdmin: false, isDeleted: false },
      },
    },
    user: {
      name: "person",
      banStatus: { isBanned: false },
      muteStatus: { isMuted: false },
      recentComments: {},
    },
  };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("standalone modmail domain", () => {
  it("fetches and objectifies a realistic conversation envelope", async () => {
    const api = client([conversationEnvelope()]);
    const signal = new AbortController().signal;
    const conversation = await new ModmailDomain(
      api,
      "typescript",
    ).conversation("abc", {
      markRead: true,
      signal,
    });

    expect(conversation).toBeInstanceOf(ModmailConversation);
    expect(conversation.owner).toBeInstanceOf(Subreddit);
    expect(conversation.participant).toBeInstanceOf(ModmailUser);
    expect(conversation.authors[0]).toBeInstanceOf(ModmailAuthor);
    expect(conversation.messages[0]).toBeInstanceOf(ModmailMessage);
    expect(conversation.modActions[0]).toBeInstanceOf(ModmailAction);
    expect(conversation.user).toBeInstanceOf(ModmailUser);
    expect(api.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/mod/conversations/abc",
      params: { markRead: true },
      signal,
    });
  });

  it("lists filtered conversations and follows ID cursors", async () => {
    const first = conversationEnvelope("one");
    const second = conversationEnvelope("two");
    const api = client([
      {
        conversationIds: ["one"],
        conversations: { one: first.conversation },
        messages: first.messages,
        modActions: first.modActions,
      },
      {
        conversationIds: ["two"],
        conversations: { two: second.conversation },
        messages: second.messages,
        modActions: second.modActions,
      },
    ]);
    const values = await collect(
      new ModmailDomain(api, "typescript").conversations({
        limit: 2,
        otherSubreddits: ["javascript"],
        requestLimit: 1,
        sort: "unread",
        state: "new",
      }),
    );

    expect(values.map(String)).toEqual(["one", "two"]);
    expect(api.request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/api/mod/conversations/",
      params: {
        after: "one",
        entity: "typescript,javascript",
        limit: 1,
        sort: "unread",
        state: "new",
      },
    });
  });

  it("creates conversations and exposes subreddit, bulk-read, and count APIs", async () => {
    const api = client([
      conversationEnvelope("created"),
      {
        subreddits: {
          t5_1: { displayName: "typescript", id: "1", lastUpdated: "today" },
        },
      },
      { conversationIds: ["created", "other"] },
      { archived: 1, new: 2 },
    ]);
    const domain = new ModmailDomain(api, "typescript");

    await expect(
      domain.create({ body: "Body", recipient: "person", subject: "Subject" }),
    ).resolves.toBeInstanceOf(ModmailConversation);
    expect((await domain.subreddits())[0]).toBeInstanceOf(Subreddit);
    expect((await domain.bulkRead({ state: "new" })).map(String)).toEqual([
      "created",
      "other",
    ]);
    await expect(domain.unreadCount()).resolves.toEqual({
      archived: 1,
      new: 2,
    });
  });

  it("supports every conversation mutation and parses replies", async () => {
    const base = conversationEnvelope();
    const reply = {
      ...base,
      conversation: {
        ...base.conversation,
        objIds: [...base.conversation.objIds, { key: "messages", id: "m2" }],
      },
      messages: {
        ...base.messages,
        m2: {
          id: "m2",
          bodyMarkdown: "Answer",
          isInternal: false,
          author: { name: "mod", isAdmin: false, isDeleted: false },
        },
      },
    };
    const api = client([reply, null, null, null, null, null, null, null, null]);
    const conversation = new ModmailConversation(api, "abc");

    await expect(
      conversation.reply({ body: "answer" }),
    ).resolves.toBeInstanceOf(ModmailMessage);
    await conversation.archive();
    await conversation.unarchive();
    await conversation.highlight();
    await conversation.unhighlight();
    await conversation.mute({ numDays: 7 });
    await conversation.unmute();
    await conversation.read(["def"]);
    await conversation.unread();
    expect(
      api.request.mock.calls.map(
        ([value]) => (value as { readonly path: string }).path,
      ),
    ).toEqual([
      "/api/mod/conversations/abc",
      "/api/mod/conversations/abc/archive",
      "/api/mod/conversations/abc/unarchive",
      "/api/mod/conversations/abc/highlight",
      "/api/mod/conversations/abc/highlight",
      "/api/mod/conversations/abc/mute",
      "/api/mod/conversations/abc/unmute",
      "/api/mod/conversations/read",
      "/api/mod/conversations/unread",
    ]);
    expect(api.request.mock.calls[5]?.[0]).toMatchObject({
      params: { num_hours: 168 },
    });
  });

  it("provides legacy listing, send, reply, and polling adapter", async () => {
    const listing = {
      kind: "Listing",
      data: {
        after: null,
        children: [
          {
            kind: "t4",
            data: { id: "old", name: "t4_old", subject: "Legacy" },
          },
        ],
      },
    };
    const api = client([
      listing,
      null,
      { json: { data: { things: [{ kind: "t4", data: { id: "reply" } }] } } },
      listing,
    ]);
    const legacy = new LegacyModmailDomain(api, "typescript");
    const [message] = await collect(legacy.inbox({ limit: 1 }));
    expect(message).toBeInstanceOf(LegacyModmailMessage);
    expect(api.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/r/typescript/message/moderator/",
      params: { limit: 1 },
    });
    await legacy.send({
      body: "Body",
      recipient: "person",
      subject: "Subject",
    });
    await expect(message!.reply("Reply")).resolves.toBeInstanceOf(
      LegacyModmailMessage,
    );
    const stream = legacy.stream({ pauseAfter: 0 });
    await expect(stream.next()).resolves.toMatchObject({ value: message });
    await stream.return(undefined);
  });

  it("rejects read-only and cancelled operations before dispatch", async () => {
    const readOnly = client([], true);
    expect(() => new ModmailDomain(readOnly, "test").conversations()).toThrow(
      "read-only",
    );
    await expect(
      new LegacyModmailDomain(readOnly, "test").send({
        body: "body",
        subject: "subject",
      }),
    ).rejects.toThrow("read-only");
    const controller = new AbortController();
    controller.abort();
    const api = client();
    await expect(
      new ModmailDomain(api, "test").unreadCount(controller.signal),
    ).rejects.toThrow();
    expect(api.request).not.toHaveBeenCalled();
  });

  it("normalizes aliases, defaults, references, and all-subreddit listings", async () => {
    const created = conversationEnvelope("created");
    const api = client([
      conversationEnvelope("prefixed"),
      created,
      { conversationIds: [], conversations: {} },
      { conversation_ids: ["one"] },
    ]);
    const domain = new ModmailDomain(api, new Subreddit(api, "typescript"));

    expect(
      String(await domain.conversation("ModmailConversation_prefixed")),
    ).toBe("prefixed");
    await domain.create({
      authorHidden: true,
      body: " body ",
      recipient: new ModmailAuthor(api, { name: "person" }),
      subject: " subject ",
    });
    expect(api.request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/mod/conversations/",
      data: {
        body: "body",
        isAuthorHidden: true,
        srName: "typescript",
        subject: "subject",
        to: "person",
      },
    });
    await expect(
      collect(new ModmailDomain(api, "all").conversations({ limit: 1 })),
    ).resolves.toEqual([]);
    expect(api.request.mock.calls[2]?.[0]).toMatchObject({
      params: { limit: 1 },
    });
    await expect(domain.bulkRead()).resolves.toEqual([
      expect.any(ModmailConversation),
    ]);
  });

  it("validates domain input, listings, and malformed envelopes", async () => {
    expect(() => new ModmailDomain(client(), " ")).toThrow(
      "subreddit cannot be empty",
    );
    const domain = new ModmailDomain(client(), "test");
    await expect(domain.conversation(" ")).rejects.toThrow(
      "conversation ID cannot be empty",
    );
    expect(() => domain.conversations({ after: " " })).toThrow("after cursor");
    await expect(new ModmailDomain(client(), "all").bulkRead()).rejects.toThrow(
      "explicit subreddit",
    );
    for (const response of [
      null,
      { conversationIds: "bad", conversations: {} },
      { conversationIds: [1], conversations: {} },
      { conversationIds: ["missing"], conversations: {} },
    ]) {
      await expect(
        collect(new ModmailDomain(client([response]), "test").conversations()),
      ).rejects.toThrow(
        /invalid modmail conversations|omitted modmail conversation/,
      );
    }
    await expect(
      new ModmailDomain(client([{}]), "test").bulkRead(),
    ).rejects.toThrow("invalid bulk-read");
  });

  it("parses participating subreddits and unread counts defensively", async () => {
    const signal = new AbortController().signal;
    const api = client([
      { subreddits: { one: { displayName: "one" } } },
      null,
      { subreddits: [] },
      { subreddits: { one: null } },
      { subreddits: { one: { displayName: 1 } } },
      { new: 1 },
      null,
      { new: "1" },
    ]);
    const domain = new ModmailDomain(api, "test");
    await expect(domain.subreddits(signal)).resolves.toEqual([
      expect.any(Subreddit),
    ]);
    await expect(domain.subreddits()).rejects.toThrow(
      "invalid modmail subreddits",
    );
    await expect(domain.subreddits()).rejects.toThrow(
      "invalid modmail subreddits",
    );
    await expect(domain.subreddits()).rejects.toThrow(
      "invalid modmail subreddit",
    );
    await expect(domain.subreddits()).rejects.toThrow(
      "invalid modmail subreddit",
    );
    await expect(domain.unreadCount()).resolves.toEqual({ new: 1 });
    await expect(domain.unreadCount()).rejects.toThrow(
      "invalid modmail unread counts",
    );
    await expect(domain.unreadCount()).rejects.toThrow(
      "invalid modmail unread counts",
    );
  });

  it("polls modern conversations and forwards stream listing options", async () => {
    const envelope = conversationEnvelope("streamed");
    const api = client([
      {
        conversationIds: ["streamed"],
        conversations: { streamed: envelope.conversation },
        messages: envelope.messages,
        modActions: envelope.modActions,
      },
      { conversationIds: [], conversations: {} },
    ]);
    const stream = new ModmailDomain(api, "test").stream({
      pauseAfter: -1,
      state: "new",
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: expect.any(ModmailConversation),
    });
    expect(api.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/mod/conversations/",
      params: { entity: "test", limit: 100, state: "new" },
    });
    await stream.return(undefined);
  });

  it("covers legacy aliases, queues, recipient defaults, and empty replies", async () => {
    const listing = { kind: "Listing", data: { after: null, children: [] } };
    const api = client([
      listing,
      listing,
      null,
      null,
      [],
      { things: [{ id: "r" }] },
    ]);
    const legacy = new LegacyModmailDomain(api, "type script");
    await collect(legacy.list({ limit: 1 }));
    await collect(legacy.unread({ limit: 1 }));
    expect(api.request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/r/type%20script/message/moderator/unread/",
      params: { limit: 1 },
    });
    await legacy.send({ body: " body ", subject: " subject " });
    await legacy.send({
      body: "body",
      recipient: "person",
      subject: "subject",
    });
    expect(api.request.mock.calls[2]?.[0]).toMatchObject({
      data: { subject: "subject", text: "body", to: "#type script" },
    });
    expect(api.request.mock.calls[3]?.[0]).toMatchObject({
      data: { from_sr: "type script", to: "person" },
    });
    const message = new LegacyModmailMessage(api, {
      id: "old",
      name: "t4_old",
    });
    await expect(message.reply("body")).resolves.toBeNull();
    await expect(message.reply("body")).resolves.toBeInstanceOf(
      LegacyModmailMessage,
    );
  });

  it("models author fallbacks, participants, identity, and parser envelope variants", () => {
    const api = client();
    expect(String(new ModmailAuthor(api, { id: "id-user" }))).toBe("id-user");
    expect(String(new ModmailAuthor(api, {}))).toBe("[deleted]");
    expect(String(new ModmailUser(api, { user: "named" }))).toBe("named");
    expect(String(new ModmailUser(api, {}))).toBe("[deleted]");
    expect(
      String(new ModmailConversation(api, "ModmailConversation_abc")),
    ).toBe("abc");
    expect(() => new ModmailConversation(api, " ")).toThrow("cannot be empty");
    expect(() =>
      new ModmailConversation(api, {
        conversation: { id: null },
      }).toString(),
    ).toThrow("no valid ID");

    const direct = parseModmailConversation(api, {
      id: "direct",
      participant: null,
    });
    expect(String(direct)).toBe("direct");
    expect(direct.owner).toBeNull();
    expect(direct.participant).toBeNull();
    const expected = parseModmailConversation(
      api,
      { conversations: { wanted: { id: "wanted" }, other: { id: "other" } } },
      "wanted",
    );
    expect(String(expected)).toBe("wanted");
    expect(
      String(
        parseModmailConversation(api, {
          conversations: { first: { id: "first" } },
        }),
      ),
    ).toBe("first");
    expect(() => parseModmailConversation(api, {})).toThrow(
      "invalid modmail conversation",
    );
    expect(() =>
      parseModmailConversation(api, {
        conversation: { id: "x", participant: 1 },
      }),
    ).toThrow("invalid modmail participant");
  });

  it("orders parser objects without globally registering parsers", () => {
    const api = client();
    const parsed = parseModmailConversation(api, {
      conversation: {
        id: "x",
        authors: ["alice", null],
        objIds: [null, { id: 1 }, { key: "messages", id: "missing" }],
      },
      messages: [{ id: "m", author: "alice" }],
      modActions: { a: { id: "a", author: null } },
    });
    expect(parsed.authors).toHaveLength(1);
    expect(parsed.messages).toEqual([expect.any(ModmailMessage)]);
    expect(parsed.modActions).toEqual([expect.any(ModmailAction)]);
    expect(String(parsed.messages[0])).toBe("m");
    expect(String(parsed.modActions[0])).toBe("a");
    expect(parseModmailMessage(api, { id: "m" })).toBeInstanceOf(
      ModmailMessage,
    );
    expect(parseModmailAction(api, { id: "a" })).toBeInstanceOf(ModmailAction);

    expect(
      new Objector(api).objectify({
        kind: "modmail_message",
        data: { id: "m" },
      }),
    ).toEqual({ kind: "modmail_message", data: { id: "m" } });
  });

  it("refreshes and validates reply envelopes and conversation actions", async () => {
    const api = client([
      conversationEnvelope("abc"),
      null,
      {},
      { messages: {}, conversation: {} },
      null,
      null,
      null,
      null,
    ]);
    const conversation = new ModmailConversation(api, "abc");
    await expect(conversation.refresh({ markRead: true })).resolves.toBe(
      conversation,
    );
    await expect(conversation.reply({ body: "x" })).rejects.toThrow(
      "invalid modmail reply",
    );
    await expect(conversation.reply({ body: "x" })).rejects.toThrow(
      "invalid modmail reply",
    );
    await expect(conversation.reply({ body: "x" })).rejects.toThrow(
      "invalid modmail message",
    );
    await conversation.mute();
    await conversation.read([
      new ModmailConversation(api, "def"),
      "ModmailConversation_ghi",
    ]);
    await conversation.archive({ signal: new AbortController().signal });
    await conversation.unhighlight();
    expect(api.request.mock.calls[4]?.[0]).not.toHaveProperty("params");
    expect(api.request.mock.calls[5]?.[0]).toMatchObject({
      data: { conversationIds: "abc,def,ghi" },
    });
  });

  it("validates bodies, authorization, malformed objects, and cancellation", async () => {
    const api = client();
    const domain = new ModmailDomain(api, "test");
    await expect(
      domain.create({ body: " ", recipient: "x", subject: "s" }),
    ).rejects.toThrow("body cannot be empty");
    await expect(
      domain.create({ body: "b", recipient: " ", subject: "s" }),
    ).rejects.toThrow("recipient cannot be empty");
    await expect(
      new LegacyModmailDomain(api, "test").send({ body: "b", subject: " " }),
    ).rejects.toThrow("subject cannot be empty");
    expect(() => new ModmailMessage(api, { id: "" }).toString()).toThrow(
      "no valid ID",
    );

    const controller = new AbortController();
    controller.abort(new Error("cancel modmail"));
    const conversation = new ModmailConversation(api, "x");
    for (const operation of [
      () => conversation.refresh({ signal: controller.signal }),
      () => conversation.reply({ body: "x", signal: controller.signal }),
      () => conversation.mute({ signal: controller.signal }),
      () => conversation.read([], { signal: controller.signal }),
      () =>
        new LegacyModmailMessage(api, { id: "x", name: "t4_x" }).reply("x", {
          signal: controller.signal,
        }),
    ]) {
      await expect(operation()).rejects.toThrow("cancel modmail");
    }

    const forbidden = client([], true);
    const blocked = new ModmailConversation(forbidden, "x");
    for (const operation of [
      () => blocked.refresh(),
      () => blocked.reply({ body: "x" }),
      () => blocked.archive(),
      () => blocked.mute(),
      () => blocked.read(),
      () =>
        new LegacyModmailMessage(forbidden, { id: "x", name: "t4_x" }).reply(
          "x",
        ),
    ]) {
      await expect(operation()).rejects.toThrow("read-only");
    }
  });
});
