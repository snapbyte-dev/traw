import { describe, expect, it, vi } from "vitest";

import type { RedditRequest } from "../src/models/base.js";
import {
  Message,
  SubredditMessage,
  messageObjector,
  objectifyMessageThread,
  type MessageClient,
} from "../src/models/messages.js";
import { Redditor, Subreddit } from "../src/models/entities.js";

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

describe("message parsing edge contracts", () => {
  it("parses bare records, model records, empty replies, and destinations", () => {
    const { client } = setup();
    const modelReply = new Message(client, {
      id: "model",
      parent_id: "t4_root",
      replies: null,
    });
    const root = new Message(client, {
      author: "author",
      dest: "recipient",
      id: "root",
      name: "t4_root",
      replies: [modelReply],
    });

    expect(root.author).toBeInstanceOf(Redditor);
    expect(root.dest).toBeInstanceOf(Redditor);
    expect(modelReply.parent).toBe(root);
    expect(modelReply.get("replies")).toEqual([]);
    expect(
      new Message(client, { dest: "#community", id: "sub", replies: undefined })
        .dest,
    ).toBeInstanceOf(Subreddit);

    const parsed = messageObjector(client).objectify({
      json: {
        data: {
          things: [root, { kind: "t4", data: { id: "raw", replies: "" } }],
        },
      },
    });
    expect(parsed).toBeDefined();
  });

  it("parses nested arrays in replies and returns the first supported reply", async () => {
    const { client, request } = setup();
    request.mockResolvedValueOnce({
      json: {
        data: {
          things: [
            [
              { ignored: true },
              {
                kind: "t1",
                data: { id: "comment", parent_id: "t4_root" },
              },
            ],
          ],
        },
      },
    });

    await expect(
      new Message(client, "root").reply("body"),
    ).resolves.toMatchObject({
      id: "comment",
    });
  });

  it("rejects malformed reply listings and raw reply children", () => {
    const { client } = setup();
    expect(
      () => new Message(client, { id: "bad", replies: { invalid: true } }),
    ).toThrow("no children array");
    expect(() => new Message(client, { id: "bad", replies: [null] })).toThrow(
      "invalid message data",
    );
  });

  it("supports direct thread arrays", () => {
    const { client } = setup();
    const messages = objectifyMessageThread(client, [
      { kind: "t4", data: { id: "root", replies: "" } },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(Message);
    expect(messages[0]?.fullname).toBe("t4_root");
  });

  it("retains subtype and parent information after refresh", async () => {
    const { client, request } = setup();
    request.mockResolvedValue({
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t4",
            data: {
              id: "root",
              replies: [
                {
                  id: "child",
                  parent_id: "t4_root",
                  replies: "",
                  subreddit: "mods",
                },
              ],
            },
          },
        ],
      },
    });
    const child = new SubredditMessage(client, "child");

    await child.refresh();

    expect(child.parent?.fullname).toBe("t4_root");
    expect(child.thread.map((message) => message.fullname)).toEqual([
      "t4_root",
      "t4_child",
    ]);
  });
});
