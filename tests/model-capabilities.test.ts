import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Clock } from "../src/core/clock.js";
import type {
  TransportRequest,
  TransportResponse,
} from "../src/core/transport.js";
import { RedditApiError } from "../src/exceptions.js";
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
      RedditApiError,
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

  it("toggles inbox replies and performs shared moderation actions", async () => {
    const { client, request } = clientWith();
    const comment = new Comment(client, { id: "c", parent_id: "t3_p" });
    const signal = new AbortController().signal;

    await comment.disableInboxReplies({ signal });
    await comment.enableInboxReplies();
    await comment.mod.approve();
    await comment.mod.lock();
    await comment.mod.unlock();
    await comment.mod.distinguish({ sticky: true });
    await comment.mod.undistinguish();
    await comment.mod.ignoreReports();
    await comment.mod.unignoreReports();
    await comment.mod.remove({ modNote: "duplicate", spam: true });

    expect(request.mock.calls.map(([call]) => call)).toEqual([
      {
        data: { id: "t1_c", state: false },
        method: "POST",
        path: "/api/sendreplies",
        signal,
      },
      {
        data: { id: "t1_c", state: true },
        method: "POST",
        path: "/api/sendreplies",
      },
      { data: { id: "t1_c" }, method: "POST", path: "/api/approve/" },
      { data: { id: "t1_c" }, method: "POST", path: "/api/lock/" },
      { data: { id: "t1_c" }, method: "POST", path: "/api/unlock/" },
      {
        data: { how: "yes", id: "t1_c", sticky: true },
        method: "POST",
        path: "/api/distinguish/",
      },
      {
        data: { how: "no", id: "t1_c" },
        method: "POST",
        path: "/api/distinguish/",
      },
      { data: { id: "t1_c" }, method: "POST", path: "/api/ignore_reports/" },
      { data: { id: "t1_c" }, method: "POST", path: "/api/unignore_reports/" },
      {
        data: { id: "t1_c", spam: true },
        method: "POST",
        path: "/api/remove/",
      },
      {
        data: {
          json: JSON.stringify({
            item_ids: ["t1_c"],
            mod_note: "duplicate",
            reason_id: null,
          }),
        },
        method: "POST",
        path: "/api/v1/modactions/removal_reasons",
      },
    ]);
    expect(() => comment.mod.distinguish({ how: "bad" as "yes" })).toThrow(
      "Invalid distinguish",
    );
    await expect(comment.mod.remove({ modNote: "" })).rejects.toThrow(
      "cannot be blank",
    );
  });

  it("supports comment root and lazy parent discovery", () => {
    const { client } = clientWith();
    const root = new Comment(client, {
      id: "root",
      link_id: "t3_post",
      parent_id: "t3_post",
    });
    const child = new Comment(client, {
      id: "child",
      link_id: "t3_post",
      parent_id: "t1_parent",
    });

    expect(root.isRoot).toBe(true);
    expect(root.parent()).toMatchObject({ fullname: "t3_post" });
    expect(child.isRoot).toBe(false);
    const parent = child.parent();
    expect(parent).toMatchObject({ fullname: "t1_parent" });
    expect(() => new Comment(client, "missing").isRoot).toThrow("parent_id");
    expect(() => new Comment(client, "missing").parent()).toThrow("parent_id");
  });

  it("handles submission discovery, crosspost, flair, visit, and state moderation", async () => {
    const { client, request } = clientWith();
    request
      .mockResolvedValueOnce({
        kind: "t3",
        data: { id: "cross", subreddit: "target", title: "Cross" },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        choices: [
          {
            flair_template_id: "template",
            flair_text: "Choice",
            flair_text_editable: true,
          },
        ],
      });
    const submission = new Submission(client, {
      id: "post",
      subreddit: "source",
      title: "Original",
    });
    const signal = new AbortController().signal;

    expect(submission.duplicates({ limit: 2 })).toMatchObject({
      limit: 2,
      url: "/duplicates/post/",
    });
    await expect(
      submission.crosspost("target", {
        flairId: "flair",
        flairText: "custom",
        nsfw: true,
        sendReplies: false,
        signal,
        spoiler: true,
      }),
    ).resolves.toBeInstanceOf(Submission);
    await submission.markVisited();
    await expect(submission.flair.choices()).resolves.toEqual([
      expect.objectContaining({
        flairTemplateId: "template",
        flairText: "Choice",
        flairTextEditable: true,
      }),
    ]);
    await submission.flair.select("template", { text: "edited" });
    await submission.mod.nsfw();
    await submission.mod.sfw();
    await submission.mod.spoiler();
    await submission.mod.unspoiler();
    await submission.mod.contestMode({ state: false });
    await submission.mod.sticky({ bottom: false });
    await submission.mod.suggestedSort("qa");
    await submission.mod.updateCrowdControlLevel(3);
    await submission.mod.setOriginalContent();
    await submission.mod.unsetOriginalContent();

    expect(request.mock.calls[0]?.[0]).toEqual({
      data: {
        crosspost_fullname: "t3_post",
        flair_id: "flair",
        flair_text: "custom",
        kind: "crosspost",
        nsfw: true,
        sendreplies: false,
        spoiler: true,
        sr: "target",
        title: "Original",
      },
      method: "POST",
      path: "/api/submit/",
      signal,
    });
    expect(request.mock.calls.map(([call]) => call)).toEqual(
      expect.arrayContaining([
        {
          data: { links: "t3_post" },
          method: "POST",
          path: "/api/store_visits",
        },
        {
          data: { link: "t3_post" },
          method: "POST",
          path: "/r/source/api/flairselector/",
        },
        {
          data: {
            flair_template_id: "template",
            link: "t3_post",
            text: "edited",
          },
          method: "POST",
          path: "/r/source/api/selectflair/",
        },
        {
          data: { id: "t3_post", state: false },
          method: "POST",
          path: "/api/set_contest_mode/",
        },
        {
          data: { id: "t3_post", num: 1, state: true },
          method: "POST",
          path: "/api/set_subreddit_sticky/",
        },
        {
          data: { id: "t3_post", level: 3 },
          method: "POST",
          path: "/api/update_crowd_control_level",
        },
      ]),
    );
    await expect(submission.flair.select(" ")).rejects.toThrow(
      "cannot be empty",
    );
    expect(() => submission.mod.suggestedSort("bad" as "top")).toThrow(
      "Invalid suggested sort",
    );
    expect(() => submission.mod.updateCrowdControlLevel(4 as 3)).toThrow(
      "from 0 to 3",
    );
  });

  it("rejects malformed crosspost and flair responses", async () => {
    const { client, request } = clientWith({});
    const submission = new Submission(client, {
      id: "post",
      subreddit: "source",
      title: "Title",
    });

    await expect(submission.crosspost("target")).rejects.toThrow(
      "crosspost data",
    );
    request.mockResolvedValueOnce({ choices: [{}] });
    await expect(submission.flair.choices()).rejects.toThrow("invalid choice");
    request.mockResolvedValueOnce({});
    await expect(submission.flair.choices()).rejects.toThrow("choices array");
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
