import { describe, expect, it, vi } from "vitest";

import type { WebSocketFactory, WebSocketLike } from "../src/core/transport.js";
import { ReadOnlyError, WebSocketError } from "../src/exceptions.js";
import type { RedditClientLike, RedditRequest } from "../src/models/base.js";
import {
  Comment,
  MoreComments,
  Submission,
  Subreddit,
  createEntityContext,
  objectifyComment,
  objectifyMoreComments,
  objectifyRedditor,
  objectifySubmission,
  objectifySubreddit,
} from "../src/models/entities.js";
import { InlineImage, PostMedia } from "../src/models/media.js";

function setup(response: unknown = null): {
  client: RedditClientLike;
  request: ReturnType<
    typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
  >;
} {
  const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
  request.mockResolvedValue(response);
  return { client: { request }, request };
}

function submissionResponse(
  data: Readonly<Record<string, unknown>>,
  comments: readonly unknown[] = [],
): unknown {
  return [
    { kind: "Listing", data: { children: [{ kind: "t3", data }] } },
    { kind: "Listing", data: { children: comments } },
  ];
}

function lease(assetId = "asset"): unknown {
  return {
    args: {
      action: "//uploads.example",
      fields: [{ name: "key", value: `media/${assetId}` }],
    },
    asset: { asset_id: assetId },
  };
}

class FakeSocket implements WebSocketLike {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    // The fake has no external connection to release.
  }

  emit(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener(value);
  }
}

function mediaClient(
  update: unknown,
  options: { readonly directEvent?: boolean } = {},
): RedditClientLike {
  const socket = new FakeSocket();
  const factory = vi.fn<WebSocketFactory>(() => {
    queueMicrotask(() =>
      socket.emit(options.directEvent === true ? update : { data: update }),
    );
    return socket;
  });
  const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
  request.mockImplementation(async ({ auth, path }) => {
    if (path === "/api/media/asset.json") return lease();
    if (auth === false) return "";
    return { data: { websocket_url: "wss://media.example" } };
  });
  return { request, webSocketFactory: factory };
}

describe("content action edge contracts", () => {
  it("resolves cached, attached, and invalid comment parents", () => {
    const { client } = setup();
    const context = createEntityContext();
    const parent = objectifyComment(
      client,
      { id: "parent", link_id: "t3_post", parent_id: "t3_post" },
      context,
    );
    const child = objectifyComment(
      client,
      { id: "child", link_id: "t3_post", parent_id: "t1_parent" },
      context,
    );

    expect(child.parent()).toBe(parent);
    expect(parent.parent()).toBe(context.submission);

    const attached = new Submission(client, "attached");
    const attachedComment = new Comment(client, {
      id: "attached-comment",
      parent_id: "t3_attached",
      submission: attached,
    });
    expect(attachedComment.parent()).toBe(attached);
    expect(() =>
      new Comment(client, { id: "orphan", parent_id: "t1_parent" }).parent(),
    ).toThrow("submission reference");
    expect(() =>
      new Comment(client, { id: "bad", parent_id: "t2_user" }).parent(),
    ).toThrow("parent_id");
  });

  it("loads missing crosspost titles and rejects absent loaded titles", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce(
        submissionResponse({
          id: "post",
          subreddit: "source",
          title: "Loaded",
        }),
      )
      .mockResolvedValueOnce({
        json: {
          data: {
            things: [{ kind: "t3", data: { id: "copy", title: "Loaded" } }],
          },
        },
      });
    const source = new Submission(client, "post");

    await expect(
      source.crosspost(new Subreddit(client, "target")),
    ).resolves.toMatchObject({
      id: "copy",
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      data: {
        crosspost_fullname: "t3_post",
        kind: "crosspost",
        nsfw: false,
        sendreplies: true,
        spoiler: false,
        sr: "target",
        title: "Loaded",
      },
      method: "POST",
      path: "/api/submit/",
    });

    request.mockResolvedValueOnce(submissionResponse({ id: "untitled" }));
    await expect(
      new Submission(client, "untitled").crosspost("target"),
    ).rejects.toThrow("no title");
  });

  it("loads subreddit data for flair, maps every optional choice, and validates it", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce(
        submissionResponse({
          author: { name: "author", link_karma: 1 },
          id: "post",
          subreddit: { display_name: "a/b", id: "sub" },
          title: "Title",
        }),
      )
      .mockResolvedValueOnce({
        choices: [
          {
            flair_css_class: "blue",
            flair_template_id: "template",
            flair_text: "Text",
            flair_text_editable: false,
          },
        ],
      });
    const submission = new Submission(client, "post");

    await expect(submission.flair.choices()).resolves.toEqual([
      expect.objectContaining({
        flairCssClass: "blue",
        flairTemplateId: "template",
        flairText: "Text",
        flairTextEditable: false,
      }),
    ]);
    expect(request).toHaveBeenLastCalledWith({
      data: { link: "t3_post" },
      method: "POST",
      path: "/r/a%2Fb/api/flairselector/",
    });

    await expect(
      new Submission(client, { id: "missing" }).flair.choices(),
    ).rejects.toThrow("no subreddit");
    request.mockResolvedValueOnce({ choices: [null] });
    await expect(
      new Submission(client, { id: "bad", subreddit: "test" }).flair.choices(),
    ).rejects.toThrow("invalid choice");
  });

  it("covers submission moderation defaults and option overloads", async () => {
    const { client, request } = setup();
    const signal = new AbortController().signal;
    const submission = new Submission(client, {
      id: "post",
      subreddit: "test",
      title: "Title",
    });

    await submission.mod.contestMode();
    await submission.mod.sticky({ bottom: true, state: false, signal });
    await submission.mod.suggestedSort({ signal, sort: "top" });
    await submission.mod.suggestedSort({});
    await submission.mod.updateCrowdControlLevel(0);

    expect(request.mock.calls.map(([call]) => call)).toEqual([
      {
        data: { id: "t3_post", state: true },
        method: "POST",
        path: "/api/set_contest_mode/",
      },
      {
        data: { id: "t3_post", state: false },
        method: "POST",
        path: "/api/set_subreddit_sticky/",
        signal,
      },
      {
        data: { id: "t3_post", sort: "top" },
        method: "POST",
        path: "/api/set_suggested_sort/",
        signal,
      },
      {
        data: { id: "t3_post", sort: "blank" },
        method: "POST",
        path: "/api/set_suggested_sort/",
      },
      {
        data: { id: "t3_post", level: 0 },
        method: "POST",
        path: "/api/update_crowd_control_level",
      },
    ]);
    for (const level of [-1, 1.5]) {
      expect(() => submission.mod.updateCrowdControlLevel(level as 0)).toThrow(
        "integer from 0 to 3",
      );
    }
  });

  it("shows crowd-controlled comments and sends typed removal messages", async () => {
    const { client, request } = setup();
    const signal = new AbortController().signal;
    const comment = new Comment(client, "comment");
    const submission = new Submission(client, "post");
    request
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        kind: "t1",
        data: { id: "comment-message", parent_id: "t1_comment" },
      })
      .mockResolvedValueOnce(null);

    await comment.mod.show({ signal });
    await expect(
      comment.mod.sendRemovalMessage("Comment removed", {
        signal,
        type: "public_as_subreddit",
      }),
    ).resolves.toMatchObject({ id: "comment-message" });
    await expect(
      submission.mod.sendRemovalMessage("Post removed", {
        title: "Rule 1",
        type: "private",
      }),
    ).resolves.toBeNull();

    expect(request.mock.calls.map(([call]) => call)).toEqual([
      {
        data: { id: "t1_comment" },
        method: "POST",
        path: "/api/show_comment",
        signal,
      },
      {
        data: {
          json: JSON.stringify({
            item_id: ["t1_comment"],
            message: "Comment removed",
            title: "ignored",
            type: "public_as_subreddit",
          }),
        },
        method: "POST",
        path: "/api/v1/modactions/removal_comment_message",
        signal,
      },
      {
        data: {
          json: JSON.stringify({
            item_id: ["t3_post"],
            message: "Post removed",
            title: "Rule 1",
            type: "private",
          }),
        },
        method: "POST",
        path: "/api/v1/modactions/removal_link_message",
      },
    ]);
  });

  it("rejects invalid, read-only, aborted, and malformed moderation actions", async () => {
    const { client, request } = setup({ unexpected: true });
    const comment = new Comment(client, "comment");

    await expect(comment.mod.sendRemovalMessage(" ")).rejects.toThrow(
      "cannot be empty",
    );
    await expect(
      comment.mod.sendRemovalMessage("removed", {
        type: "invalid" as "public",
      }),
    ).rejects.toThrow("Invalid removal message type");
    await expect(comment.mod.sendRemovalMessage("removed")).rejects.toThrow(
      "removal message Comment data",
    );

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(() => comment.mod.show({ signal: controller.signal })).toThrow(
      "stop",
    );

    const readOnlyClient = { readOnly: true, request: vi.fn() };
    const readOnlyComment = new Comment(readOnlyClient, "comment");
    expect(() => readOnlyComment.mod.show()).toThrow(ReadOnlyError);
    await expect(
      readOnlyComment.mod.sendRemovalMessage("removed"),
    ).rejects.toBeInstanceOf(ReadOnlyError);
    expect(readOnlyClient.request).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects mismatched inline placeholder media before upload", async () => {
    const { client, request } = setup();
    const image = new InlineImage({
      media: PostMedia.fromBytes(new Uint8Array(), "photo.png"),
    });
    Object.defineProperty(image, "type", { value: "video" });

    await expect(
      new Subreddit(client, "test").submit("bad", {
        inlineMedia: { media: image },
        kind: "text",
        selftext: "{media}",
      }),
    ).rejects.toThrow("wrong media type");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("entity parsing and media protocol edges", () => {
  it("deduplicates entity factories and preserves enriched object data", () => {
    const { client } = setup();
    const context = createEntityContext();
    const firstSubmission = objectifySubmission(
      client,
      { id: "post" },
      context,
    );
    const firstMore = objectifyMoreComments(
      client,
      { children: ["a"], count: 1, parent_id: "t3_post" },
      context,
    );
    const firstUser = objectifyRedditor(client, { name: "User" }, context);
    const firstSubreddit = objectifySubreddit(
      client,
      { display_name: "Test" },
      context,
    );

    expect(
      objectifySubmission(client, { id: "POST", title: "new" }, context),
    ).toBe(firstSubmission);
    expect(firstSubmission.title).toBe("new");
    expect(
      objectifyMoreComments(
        client,
        { children: ["a"], count: 1, parent_id: "t3_post" },
        context,
      ),
    ).toBe(firstMore);
    expect(
      objectifyRedditor(client, { link_karma: 2, name: "user" }, context),
    ).toBe(firstUser);
    expect(firstUser.link_karma).toBe(2);
    expect(
      objectifySubreddit(client, { display_name: "test", id: "id" }, context),
    ).toBe(firstSubreddit);
    expect(firstSubreddit.fullname).toBe("t5_id");
    expect(objectifyRedditor(client, { id: "anonymous" }, context)).not.toBe(
      firstUser,
    );
    expect(objectifySubreddit(client, { id: "anonymous" }, context)).not.toBe(
      firstSubreddit,
    );
  });

  it("rejects malformed submission, comment, and continuation listings", async () => {
    const cases: readonly [unknown, string][] = [
      [null, "two listings"],
      [submissionResponse({ id: "other" }), "different submission"],
      [
        [
          { kind: "Listing", data: { children: [] } },
          { kind: "Listing", data: { children: [] } },
        ],
        "its submission",
      ],
      [[{ data: { children: [] } }, {}], "no children array"],
    ];
    for (const [response, message] of cases) {
      const { client } = setup(response);
      await expect(new Submission(client, "post").refresh()).rejects.toThrow(
        message,
      );
    }

    expect(
      () =>
        new Comment(setup().client, {
          id: "comment",
          parent_id: "t3_post",
          replies: { invalid: true },
        }),
    ).toThrow("no children array");
    expect(
      () =>
        new Comment(setup().client, {
          id: "comment",
          replies: [{ kind: "t2", data: { name: "user" } }],
        }),
    ).toThrow("comment replies require a submission");

    const { client } = setup(submissionResponse({ id: "post" }));
    await expect(
      new MoreComments(client, {
        children: [],
        count: 0,
        parent_id: "t3_post",
      }).comments(new Submission(client, "post")),
    ).rejects.toThrow("comment parent");
    await expect(
      new MoreComments(client, { children: [], count: 1 }).comments(
        new Submission(client, "post"),
      ),
    ).rejects.toThrow("no children");
  });

  it("accepts Blob and typed-array updates and rejects invalid protocol values", async () => {
    const success = JSON.stringify({
      payload: { redirect: "https://reddit.com/r/test/comments/blob/title" },
      type: "success",
    });
    await expect(
      new Subreddit(mediaClient(new Blob([success])), "test").submit("blob", {
        image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
        kind: "image",
      }),
    ).resolves.toMatchObject({ id: "blob" });
    await expect(
      new Subreddit(
        mediaClient(new TextEncoder().encode(success).subarray(0)),
        "test",
      ).submit("view", {
        image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
        kind: "image",
      }),
    ).resolves.toMatchObject({ id: "blob" });
    await expect(
      new Subreddit(mediaClient(7, { directEvent: true }), "test").submit(
        "invalid",
        {
          image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
          kind: "image",
        },
      ),
    ).rejects.toBeInstanceOf(WebSocketError);
  });

  it("honors an already-aborted media signal and skips absent socket URLs", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
    const client: RedditClientLike = { request };
    expect(() =>
      new Subreddit(client, "test").submit("image", {
        image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
        kind: "image",
        signal: controller.signal,
      }),
    ).toThrow("stop");

    request.mockImplementation(async ({ auth, path }) => {
      if (path === "/api/media/asset.json") return lease();
      if (auth === false) return "";
      return { json: { data: {} } };
    });
    await expect(
      new Subreddit(client, "test").submit("image", {
        image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
        kind: "image",
      }),
    ).resolves.toEqual({ json: { data: {} } });
  });
});
