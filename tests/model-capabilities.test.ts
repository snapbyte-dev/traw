import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Clock } from "../src/core/clock.js";
import type {
  TransportRequest,
  TransportResponse,
} from "../src/core/transport.js";
import { RedditAPIException } from "../src/exceptions.js";
import { CommentForest } from "../src/models/comment-forest.js";
import type { RedditClientLike, RedditRequest } from "../src/models/base.js";
import {
  Comment,
  MoreComments,
  Redditor,
  Submission,
  Subreddit,
  type SubmitOptions,
} from "../src/models/entities.js";
import { Media, PostMedia } from "../src/models/media.js";
import { Reddit } from "../src/reddit.js";

function clientWith(response: unknown = null): {
  readonly client: RedditClientLike;
  readonly request: ReturnType<
    typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
  >;
} {
  const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
  request.mockResolvedValue(response);
  return { client: { request }, request };
}

function response(value: unknown): TransportResponse {
  const body = JSON.stringify(value);
  return {
    body,
    headers: {},
    json: () => JSON.parse(body) as unknown,
    status: 200,
    statusText: "OK",
    text: () => body,
    url: "https://oauth.reddit.com/api/test",
  };
}

describe("model request capabilities", () => {
  it("sends user-content action payloads", async () => {
    const { client, request } = clientWith();
    const comment = new Comment(client, "abc");
    const submission = new Submission(client, "xyz");
    request
      .mockResolvedValueOnce({
        json: {
          errors: [],
          data: {
            things: [
              {
                kind: "t1",
                data: { body: "hello", id: "reply", parent_id: "t1_abc" },
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        json: {
          errors: [],
          data: {
            things: [
              {
                kind: "t1",
                data: { body: "updated", id: "abc", replies: ["new"] },
              },
            ],
          },
        },
      });

    const reply = await comment.reply("hello");
    const edited = await comment.edit("updated");
    await comment.delete();
    await comment.downvote();
    await comment.clearVote();
    await comment.save("reference");
    await comment.unsave();
    await comment.report("spam");
    await submission.hide();
    await submission.unhide();

    expect(reply).toBeInstanceOf(Comment);
    expect(reply.body).toBe("hello");
    expect(edited).toBe(comment);
    expect(comment.body).toBe("updated");

    expect(request.mock.calls.map(([value]) => value)).toEqual([
      {
        method: "POST",
        path: "/api/comment",
        data: { text: "hello", thing_id: "t1_abc" },
      },
      {
        method: "POST",
        path: "/api/editusertext",
        data: {
          text: "updated",
          thing_id: "t1_abc",
          validate_on_submit: true,
        },
      },
      { method: "POST", path: "/api/del", data: { id: "t1_abc" } },
      { method: "POST", path: "/api/vote", data: { dir: -1, id: "t1_abc" } },
      { method: "POST", path: "/api/vote", data: { dir: 0, id: "t1_abc" } },
      {
        method: "POST",
        path: "/api/save",
        data: { category: "reference", id: "t1_abc" },
      },
      { method: "POST", path: "/api/unsave", data: { id: "t1_abc" } },
      {
        method: "POST",
        path: "/api/report",
        data: { id: "t1_abc", reason: "spam" },
      },
      { method: "POST", path: "/api/hide", data: { id: "t3_xyz" } },
      { method: "POST", path: "/api/unhide", data: { id: "t3_xyz" } },
    ]);
  });

  it("subscribes and sends private messages with PRAW payload names", async () => {
    const { client, request } = clientWith();
    const subreddit = new Subreddit(client, "typescript");

    await subreddit.subscribe();
    await subreddit.unsubscribe();
    await new Redditor(client, "spez").message("subject", "body");

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/subscribe",
      data: {
        action: "sub",
        skip_inital_defaults: true,
        sr_name: "typescript",
      },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/subscribe",
      data: { action: "unsub", sr_name: "typescript" },
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "POST",
      path: "/api/compose",
      data: { subject: "subject", text: "body", to: "spez" },
    });
  });

  it("uses objectified POST errors and retries for model mutations", async () => {
    const values = [
      {
        json: {
          errors: [["RATELIMIT", "Try again in 1 second.", "ratelimit"]],
        },
      },
      {
        json: {
          errors: [],
          data: {
            things: [
              {
                kind: "t1",
                data: {
                  body: "created",
                  id: "child",
                  parent_id: "t1_parent",
                },
              },
            ],
          },
        },
      },
      {
        json: {
          errors: [],
          data: {
            things: [
              {
                kind: "t1",
                data: {
                  body: "edited",
                  id: "parent",
                  replies: ["replacement"],
                },
              },
            ],
          },
        },
      },
      { json: { errors: [["BAD_REASON", "Invalid reason", "reason"]] } },
    ];
    const sleep = vi.fn(async () => undefined);
    const clock: Clock = { now: () => 0, sleep };
    const send = vi.fn<
      (request: TransportRequest) => Promise<TransportResponse>
    >(async () => response(values.shift()));
    const reddit = new Reddit({
      clientId: "client",
      clientSecret: null,
      clock,
      headerProvider: {
        canRefresh: () => false,
        headers: () => ({}),
        invalidate: () => undefined,
      },
      transport: { send },
      userAgent: "traw:test",
    });
    const originalReplies = ["original"];
    const comment = new Comment(reddit, {
      body: "before",
      id: "parent",
      replies: originalReplies,
    });

    const reply = await comment.reply("created");
    const edited = await comment.edit("edited");

    expect(reply).toBeInstanceOf(Comment);
    expect(reply.body).toBe("created");
    expect(edited).toBe(comment);
    expect(comment.body).toBe("edited");
    expect(comment.replies).toBe(originalReplies);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(2_000, undefined);

    await expect(comment.report("invalid")).rejects.toBeInstanceOf(
      RedditAPIException,
    );
    expect(send).toHaveBeenCalledTimes(4);
    expect(String(send.mock.calls[3]![0].body?.create())).toContain(
      "id=t1_parent",
    );
  });

  it("validates and submits discriminated text and poll options", async () => {
    const { client, request } = clientWith();
    const subreddit = new Subreddit(client, "test");

    await subreddit.submit("title", { kind: "text", selftext: "content" });
    await subreddit.submit("poll", {
      duration: 3,
      kind: "poll",
      options: ["yes", "no"],
    });

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/submit",
      data: {
        kind: "self",
        nsfw: false,
        resubmit: true,
        sendreplies: true,
        spoiler: false,
        sr: "test",
        text: "content",
        title: "title",
        validate_on_submit: true,
      },
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      path: "/api/submit_poll_post",
      json: {
        duration: 3,
        options: ["yes", "no"],
        resubmit: true,
        text: "",
      },
    });
    expect(() =>
      subreddit.submit("bad", {
        duration: 8,
        kind: "poll",
        options: ["yes", "no"],
      }),
    ).toThrow("duration");
  });
});

describe("comment replacement", () => {
  it("resolves largest placeholders first and removes skipped placeholders", async () => {
    const responses = [
      {
        json: {
          data: {
            things: [
              {
                kind: "t1",
                data: { body: "child", id: "c", parent_id: "t3_post" },
              },
            ],
          },
        },
      },
    ];
    const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
    request.mockImplementation(async () => responses.shift());
    const client: RedditClientLike = { request };
    const submission = new Submission(client, "post");
    const small = new MoreComments(client, {
      children: ["s"],
      count: 1,
      parent_id: "t3_post",
    });
    const large = new MoreComments(client, {
      children: ["c"],
      count: 10,
      parent_id: "t3_post",
    });
    const forest = new CommentForest(submission, [small, large]);

    const skipped = await forest.replaceMore({ limit: 1 });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      data: { children: "c", link_id: "t3_post" },
    });
    expect(skipped).toEqual([small]);
    expect(
      forest.list().map((item) => (item instanceof Comment ? item.body : item)),
    ).toEqual(["child"]);
  });
});

describe("media", () => {
  it("snapshots byte and path sources and creates independent retries", () => {
    const original = new Uint8Array([1, 2, 3]);
    const bytes = new PostMedia(original, "image.png", { maxSize: 3 });
    original[0] = 9;
    const first = bytes.create();
    first[1] = 9;
    expect(bytes.create()).toEqual(new Uint8Array([1, 2, 3]));
    expect(bytes.mimeType).toBe("image/png");
    expect(() => bytes.validateSize(2)).toThrow("exceeds maximum");

    const directory = mkdtempSync(join(tmpdir(), "traw-media-"));
    const path = join(directory, "clip.mp4");
    try {
      writeFileSync(path, new Uint8Array([4, 5]));
      const media = Media.fromPath(path, { maxSize: 2 });
      writeFileSync(path, new Uint8Array([8]));
      expect(media.create()).toEqual(new Uint8Array([4, 5]));
      expect(media.contentType).toBe("video/mp4");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

const validSubmitOptions: SubmitOptions = {
  kind: "link",
  url: "https://example.com",
};
void validSubmitOptions;

// @ts-expect-error link submissions require a URL
const invalidLink: SubmitOptions = { kind: "link" };
const invalidText: SubmitOptions = {
  kind: "text",
  selftext: "body",
  // @ts-expect-error text submissions cannot contain a URL
  url: "https://example.com",
};
void invalidLink;
void invalidText;
