import { describe, expect, it, vi } from "vitest";

import { InboxDomain } from "../src/domains/inbox.js";
import type { RedditRequest } from "../src/models/base.js";
import { Redditor, Subreddit } from "../src/models/entities.js";
import {
  Message,
  SubredditMessage,
  type MessageClient,
} from "../src/models/messages.js";

function setup(readOnly = false): {
  client: MessageClient;
  request: ReturnType<
    typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
  >;
} {
  const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
  request.mockResolvedValue(null);
  return { client: { readOnly, request }, request };
}

function thread(): unknown {
  return {
    kind: "Listing",
    data: {
      after: null,
      children: [
        {
          kind: "t4",
          data: {
            author: "sender",
            dest: "#typescript",
            id: "root",
            name: "t4_root",
            replies: {
              kind: "Listing",
              data: {
                children: [
                  {
                    kind: "t4",
                    data: {
                      author: "reply-author",
                      dest: "recipient",
                      id: "child",
                      name: "t4_child",
                      parent_id: "t4_root",
                      replies: "",
                    },
                  },
                ],
              },
            },
            subreddit: "typescript",
          },
        },
      ],
    },
  };
}

describe("standalone inbox and messages", () => {
  it("exposes all views with rich t4 objectification", async () => {
    const { client, request } = setup();
    request.mockResolvedValue(thread());
    const inbox = new InboxDomain(client);
    const views = [
      inbox.all(),
      inbox.unread({ markRead: true }),
      inbox.messages(),
      inbox.commentReplies(),
      inbox.submissionReplies(),
      inbox.mentions(),
      inbox.sent(),
    ];
    expect(views.map((view) => view.url)).toEqual([
      "/message/inbox/",
      "/message/unread/",
      "/message/messages/",
      "/message/comments/",
      "/message/selfreply/",
      "/message/mentions",
      "/message/sent/",
    ]);

    const [message] = await (async () => {
      const result: Message[] = [];
      for await (const item of views[2]!) result.push(item as Message);
      return result;
    })();
    expect(message).toBeInstanceOf(SubredditMessage);
    expect(message?.author).toBeInstanceOf(Redditor);
    expect(message?.dest).toBeInstanceOf(Subreddit);
    expect(message?.get<Message[]>("replies")?.[0]?.parent).toBe(message);
  });

  it("fetches a selected child and wires its parent thread", async () => {
    const { client, request } = setup();
    request.mockResolvedValue(thread());
    const message = await new InboxDomain(client).message("t4_child");

    expect(message).toBeInstanceOf(Message);
    expect(message.fullname).toBe("t4_child");
    expect(message.parent?.fullname).toBe("t4_root");
    expect(message.thread.map((item) => item.fullname)).toEqual([
      "t4_root",
      "t4_child",
    ]);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/message/messages/child/",
    });
  });

  it("batches read state and collapse mutations at 25", async () => {
    const { client, request } = setup();
    const inbox = new InboxDomain(client);
    const ids = Array.from({ length: 26 }, (_, index) => `t4_${index}`);
    const signal = new AbortController().signal;

    await inbox.markRead(ids, signal);
    await inbox.markUnread([{ fullname: "t4_unread" }]);
    await inbox.collapse(["t4_collapse"]);
    await inbox.uncollapse(["t4_expand"]);
    await inbox.markAllRead();

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/read_message/",
      data: { id: ids.slice(0, 25).join(",") },
      signal,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/read_message/",
      data: { id: "t4_25" },
      signal,
    });
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/api/read_all_messages",
    });
  });

  it("implements message actions, reply parsing, hydration, and deletion", async () => {
    const { client, request } = setup();
    const signal = new AbortController().signal;
    request
      .mockResolvedValueOnce({
        json: {
          data: {
            things: [
              { kind: "t4", data: { id: "reply", replies: "", subject: "Re" } },
            ],
          },
        },
      })
      .mockResolvedValueOnce(thread());
    const message = new Message(client, "root");

    await expect(message.reply("body", { signal })).resolves.toBeInstanceOf(
      Message,
    );
    await message.refresh({ signal });
    expect(message.isLoaded).toBe(true);
    await message.block({ signal });
    await message.collapse();
    await message.uncollapse();
    await message.markRead();
    await message.markUnread();
    await message.delete();

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/comment",
      data: { text: "body", thing_id: "t4_root" },
      signal,
    });
    expect(request.mock.calls.slice(2).map(([value]) => value.path)).toEqual([
      "/api/block",
      "/api/collapse_message/",
      "/api/uncollapse_message/",
      "/api/read_message/",
      "/api/unread_message/",
      "/api/del_msg",
    ]);
  });

  it("enforces auth, cancellation, IDs, and missing message handling", async () => {
    const blocked = setup(true);
    expect(() => new InboxDomain(blocked.client).all()).toThrow("read-only");
    await expect(new Message(blocked.client, "id").delete()).rejects.toThrow(
      "read-only",
    );

    const { client, request } = setup();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      new InboxDomain(client).collapse([], controller.signal),
    ).rejects.toThrow("stop");
    expect(request).not.toHaveBeenCalled();
    expect(() => new Message(client, " ")).toThrow(
      "message ID cannot be empty",
    );
    await expect(new Message(client, "id").reply(" ")).rejects.toThrow(
      "body cannot be empty",
    );

    request.mockResolvedValue({ kind: "Listing", data: { children: [] } });
    await expect(new InboxDomain(client).message("missing")).rejects.toThrow(
      "did not contain message",
    );
    await expect(new InboxDomain(client).markRead([" "])).rejects.toThrow(
      "fullname cannot be empty",
    );
  });

  it("streams unread items and returns null for empty reply responses", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce({ json: { data: { things: [] } } })
      .mockResolvedValueOnce(thread());
    await expect(new Message(client, "root").reply("body")).resolves.toBeNull();

    const stream = new InboxDomain(client).stream({ pauseAfter: -1 });
    const first = await stream.next();
    expect(first.value).toBeInstanceOf(Message);
    expect(request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/message/unread/",
      params: { limit: 100, mark: false },
    });
    await stream.return(undefined);
  });

  it("rejects malformed message trees and missing refresh targets", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce({ kind: "Listing", data: { children: [null] } })
      .mockResolvedValueOnce({ kind: "Listing", data: { children: [] } });
    await expect(new InboxDomain(client).message("bad")).rejects.toThrow(
      "invalid message data",
    );
    await expect(new Message(client, "missing").refresh()).rejects.toThrow(
      "did not contain Message data",
    );

    request.mockResolvedValue({ invalid: true });
    await expect(new InboxDomain(client).message("bad-shape")).rejects.toThrow(
      "no children array",
    );
    expect(
      new Message(client, {
        id: "array-replies",
        replies: [{ id: "child", parent_id: "t4_array-replies" }],
      }).get<Message[]>("replies"),
    ).toHaveLength(1);
  });
});
