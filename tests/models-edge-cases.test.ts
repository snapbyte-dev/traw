import { describe, expect, it, vi } from "vitest";

import {
  BaseModel,
  type RedditClientLike,
  type RedditRequest,
} from "../src/models/base.js";
import { CommentForest } from "../src/models/comment-forest.js";
import {
  Comment,
  MoreComments,
  Redditor,
  Submission,
  Subreddit,
} from "../src/models/entities.js";
import { Media, PostMedia } from "../src/models/media.js";
import { Message } from "../src/models/messages.js";

function mockClient(response: unknown = null): {
  client: RedditClientLike;
  request: ReturnType<
    typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
  >;
} {
  const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
  request.mockResolvedValue(response);
  return { client: { request }, request };
}

describe("base model edge cases", () => {
  it("retains raw and reserved fields without replacing model behavior", () => {
    const { client } = mockClient();
    const model = new BaseModel(client, {
      "#private": 1,
      _internal: 2,
      client: "hostile",
      get: "hostile",
      ordinary: 3,
      raw: "hostile",
    });

    expect(model.client).toBe(client);
    expect(model.get("get")).toBe("hostile");
    expect(model.get("_internal")).toBe(2);
    expect(model.raw).toEqual({
      "#private": 1,
      _internal: 2,
      client: "hostile",
      get: "hostile",
      ordinary: 3,
      raw: "hostile",
    });
    expect((model as BaseModel & { ordinary: number }).ordinary).toBe(3);
    const copy = model.raw as Record<string, unknown>;
    copy["ordinary"] = 4;
    expect(model.get("ordinary")).toBe(3);
  });

  it("selects the matching identity from nested listings case-insensitively", async () => {
    const { client, request } = mockClient({
      data: {
        children: [
          { kind: "t2", data: { name: "other", comment_karma: 1 } },
          { kind: "t2", data: { name: "SpEz", comment_karma: 42 } },
        ],
      },
    });
    const redditor = new Redditor(client, "spez");

    await redditor.refresh();

    expect(redditor.comment_karma).toBe(42);
    expect(redditor.isLoaded).toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/user/spez/about",
    });
  });

  it("handles loaded models, aborts, malformed identities, and absent data", async () => {
    const loaded = new Redditor(mockClient().client, { name: "name" });
    await expect(loaded.load()).resolves.toBe(loaded);
    expect(loaded.equals({})).toBe(false);
    expect(loaded.equals(new Subreddit(mockClient().client, "name"))).toBe(
      false,
    );

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { client, request } = mockClient();
    await expect(
      new Redditor(client, "name").refresh({ signal: controller.signal }),
    ).rejects.toThrow("stop");
    expect(request).not.toHaveBeenCalled();

    const missing = new Redditor(mockClient(undefined).client, "name");
    await expect(missing.refresh()).rejects.toThrow(
      "did not contain Redditor data",
    );
    expect(() => new Redditor(client, {}).identity).toThrow("no valid name");
    expect(() => new Redditor(client, {}).toString()).toThrow(
      "no valid identity",
    );
  });

  it("normalizes ids and derives fullnames", () => {
    const { client } = mockClient();
    const comment = new Comment(client, "t1_ABC");
    const submission = new Submission(client, { id: "post", name: "custom" });
    const message = new Message({ ...client, readOnly: false }, "t4_abc");
    const redditor = new Redditor(client, { id: "u", name: "User" });
    const subredditByName = new Subreddit(client, {
      display_name: "one",
      name: "t5_named",
    });
    const subredditById = new Subreddit(client, {
      display_name: "two",
      id: "id",
    });

    expect(comment.toString()).toBe("ABC");
    expect(comment.identity).toBe("t1:abc");
    expect(submission.fullname).toBe("custom");
    expect(message.fullname).toBe("t4_abc");
    expect(redditor.fullname).toBe("t2_u");
    expect(new Redditor(client, "plain").fullname).toBeUndefined();
    expect(subredditByName.fullname).toBe("t5_named");
    expect(subredditById.fullname).toBe("t5_id");
    expect(new Subreddit(client, "empty").fullname).toBeUndefined();
  });
});

describe("request and submission edge cases", () => {
  it("covers every user-content action and optional signal/category payload", async () => {
    const { client, request } = mockClient();
    const comment = new Comment(client, "c");
    const signal = new AbortController().signal;

    await comment.upvote({ signal });
    await comment.save();
    await comment.vote(0);
    request.mockResolvedValue({ id: "c" });
    await comment.refresh({ signal });

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/vote",
      data: { dir: 1, id: "t1_c" },
      signal,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/save",
      data: { id: "t1_c" },
    });
    expect(request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/api/info",
      params: { id: "t1_c" },
      signal,
    });

    const controller = new AbortController();
    controller.abort();
    expect(() => comment.reply("no", { signal: controller.signal })).toThrow();
  });

  it("passes signals through redditor and subreddit methods and encodes paths", async () => {
    const { client, request } = mockClient({ display_name: "a/b" });
    const signal = new AbortController().signal;
    await new Redditor(client, "a/b").message("subject", "body", { signal });
    await new Subreddit(client, "a/b").subscribe({ signal });
    await new Subreddit(client, "a/b").unsubscribe({ signal });
    await new Subreddit(client, "a/b").refresh();

    expect(request.mock.calls[0]?.[0]).toMatchObject({ signal });
    expect(request.mock.calls[1]?.[0]).toMatchObject({ signal });
    expect(request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/r/a%2Fb/about",
    });

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      new Redditor(client, "x").message("s", "b", {
        signal: controller.signal,
      }),
    ).toThrow();
    expect(() =>
      new Subreddit(client, "x").subscribe({ signal: controller.signal }),
    ).toThrow();
  });

  it("builds link, image, video, gif, gallery, and configured poll submissions", async () => {
    const { client, request } = mockClient();
    let asset = 0;
    request.mockImplementation(async ({ auth, path }) => {
      if (path === "/api/media/asset.json") {
        asset += 1;
        return {
          args: {
            action: "//uploads.example",
            fields: [
              { name: "key", value: `media/${asset}` },
              { name: "policy", value: "signed" },
            ],
          },
          asset: { asset_id: `asset-${asset}` },
        };
      }
      if (auth === false) return "";
      return null;
    });
    const subreddit = new Subreddit(client, "test");
    const image = PostMedia.fromBytes(new Uint8Array([1]), "photo.png");
    const video = PostMedia.fromBytes(new Uint8Array([2]), "clip.mp4");

    await subreddit.submit("link", {
      kind: "link",
      url: "https://example.com",
      selftext: "context",
      nsfw: true,
    });
    await subreddit.submit("image", { kind: "image", image, selftext: "" });
    await subreddit.submit("video", {
      kind: "video",
      video,
      thumbnail: image,
      selftext: "caption",
    });
    await subreddit.submit("gif", { kind: "video", video, gif: true });
    await subreddit.submit("gallery", {
      kind: "gallery",
      items: [
        { media: image },
        {
          media: image,
          caption: "caption",
          outboundUrl: "https://example.com",
        },
      ],
      selftext: "gallery text",
      sendReplies: false,
      spoiler: true,
    });
    await subreddit.submit("poll", {
      kind: "poll",
      duration: 1,
      options: ["a", "b"],
      selftext: "body",
    });

    const submissions = request.mock.calls
      .map(([call]) => call)
      .filter(({ path }) => path.startsWith("/api/submit"));
    expect(submissions[0]).toMatchObject({
      data: {
        kind: "link",
        resubmit: true,
        text: "context",
        url: "https://example.com",
        nsfw: true,
      },
    });
    expect(submissions[1]).toMatchObject({
      data: {
        kind: "image",
        text: "",
        url: "https://uploads.example/media/1",
      },
    });
    expect(submissions[2]).toMatchObject({
      data: {
        kind: "video",
        text: "caption",
        url: "https://uploads.example/media/2",
        video_poster_url: "https://uploads.example/media/3",
      },
    });
    expect(submissions[3]).toMatchObject({
      data: {
        kind: "videogif",
        url: "https://uploads.example/media/4",
      },
    });
    expect(submissions[4]).toMatchObject({
      path: "/api/submit_gallery_post.json",
      json: {
        items: [
          { caption: "", media_id: "asset-5", outbound_url: "" },
          {
            caption: "caption",
            media_id: "asset-6",
            outbound_url: "https://example.com",
          },
        ],
        sendreplies: false,
        show_error_list: true,
        spoiler: true,
        text: "gallery text",
      },
    });
    expect(submissions[5]).toMatchObject({
      path: "/api/submit_poll_post",
      json: { options: ["a", "b"], resubmit: true, text: "body" },
    });
    expect(
      request.mock.calls.filter(([call]) => call.auth === false),
    ).toHaveLength(6);
  });

  it.each([
    [{ kind: "poll", duration: 1.5, options: ["a", "b"] }, "duration"],
    [{ kind: "poll", duration: 0, options: ["a", "b"] }, "duration"],
    [{ kind: "poll", duration: 1, options: ["only"] }, "between 2 and 6"],
    [{ kind: "poll", duration: 1, options: ["", "b"] }, "cannot be empty"],
    [
      { kind: "image", image: PostMedia.fromBytes(new Uint8Array(), "x.mp4") },
      "image MIME",
    ],
    [
      { kind: "video", video: PostMedia.fromBytes(new Uint8Array(), "x.png") },
      "video MIME",
    ],
    [{ kind: "gallery", items: [] }, "gallery cannot be empty"],
    [
      {
        kind: "gallery",
        items: [{ media: PostMedia.fromBytes(new Uint8Array(), "x.mp4") }],
      },
      "gallery media",
    ],
    [
      {
        kind: "gallery",
        items: [
          {
            media: PostMedia.fromBytes(new Uint8Array(), "x.png"),
            caption: "x".repeat(181),
          },
        ],
      },
      "180",
    ],
  ] as const)("rejects invalid submit options %#", (options, message) => {
    const subreddit = new Subreddit(mockClient().client, "test");
    expect(() => subreddit.submit("bad", options)).toThrow(message);
  });

  it("raises gallery errors returned in the JSON envelope", async () => {
    const { client, request } = mockClient();
    request
      .mockResolvedValueOnce({
        args: {
          action: "//uploads.example",
          fields: [{ name: "key", value: "media/1" }],
        },
        asset: { asset_id: "asset-1" },
      })
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce({
        json: { errors: [["BAD_MEDIA", "invalid image", "items"]] },
      });

    await expect(
      new Subreddit(client, "test").submit("gallery", {
        items: [
          {
            media: PostMedia.fromBytes(new Uint8Array([1]), "photo.png"),
          },
        ],
        kind: "gallery",
      }),
    ).rejects.toThrow("BAD_MEDIA");
  });
});

describe("MoreComments and CommentForest edge cases", () => {
  it("hydrates submissions and recursively objectifies realistic comment listings", async () => {
    const { client, request } = mockClient([
      {
        kind: "Listing",
        data: {
          after: null,
          before: null,
          children: [
            {
              kind: "t3",
              data: {
                author: "same_user",
                id: "post",
                name: "t3_post",
                subreddit: "typescript",
                title: "Hydrated post",
              },
            },
          ],
        },
      },
      {
        kind: "Listing",
        data: {
          after: null,
          before: null,
          children: [
            {
              kind: "t1",
              data: {
                author: "same_user",
                body: "parent",
                id: "parent",
                link_id: "t3_post",
                name: "t1_parent",
                parent_id: "t3_post",
                subreddit: "typescript",
                replies: {
                  kind: "Listing",
                  data: {
                    after: null,
                    before: null,
                    children: [
                      {
                        kind: "t1",
                        data: {
                          author: "child_user",
                          body: "child",
                          id: "child",
                          link_id: "t3_post",
                          name: "t1_child",
                          parent_id: "t1_parent",
                          replies: "",
                          subreddit: "typescript",
                        },
                      },
                    ],
                  },
                },
              },
            },
            {
              kind: "more",
              data: {
                children: ["later"],
                count: 1,
                id: "more",
                name: "more",
                parent_id: "t3_post",
              },
            },
          ],
        },
      },
    ]);
    const submission = new Submission(client, "post");
    submission.commentSort = "new";
    submission.commentLimit = 50;

    await expect(submission.load()).resolves.toBe(submission);

    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/comments/post/",
      params: { limit: 50, sort: "new" },
    });
    expect(submission.title).toBe("Hydrated post");
    expect(submission.comments).toBeInstanceOf(CommentForest);
    const parent = submission.comments?.at(0);
    expect(parent).toBeInstanceOf(Comment);
    if (!(parent instanceof Comment)) throw new TypeError("expected comment");
    expect(parent.replies).toBeInstanceOf(CommentForest);
    if (!(parent.replies instanceof CommentForest))
      throw new TypeError("expected reply forest");
    expect(parent.replies.at(0)).toBeInstanceOf(Comment);
    expect(parent.author).toBe(submission.author);
    expect(parent.subreddit).toBe(submission.subreddit);
    expect((parent.replies.at(0) as Comment).subreddit).toBe(
      submission.subreddit,
    );
    expect((parent as Comment & { submission: Submission }).submission).toBe(
      submission,
    );
    expect(() => {
      submission.commentSort = "top";
    }).toThrow("after this submission has been loaded");
    expect(() => {
      submission.commentLimit = 100;
    }).toThrow("after this submission has been loaded");
  });

  it("loads continuation placeholders through the parent permalink and caches replies", async () => {
    const { client, request } = mockClient([
      {
        kind: "Listing",
        data: {
          children: [{ kind: "t3", data: { id: "post", name: "t3_post" } }],
        },
      },
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t1",
              data: {
                body: "parent",
                id: "parent",
                link_id: "t3_post",
                name: "t1_parent",
                parent_id: "t3_post",
                replies: {
                  kind: "Listing",
                  data: {
                    children: [
                      {
                        kind: "t1",
                        data: {
                          body: "continued",
                          id: "continued",
                          link_id: "t3_post",
                          name: "t1_continued",
                          parent_id: "t1_parent",
                          replies: "",
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ]);
    const submission = new Submission(client, "post");
    submission.commentSort = "old";
    submission.commentLimit = 25;
    const continuation = new MoreComments(client, {
      children: [],
      count: 0,
      parent_id: "t1_parent",
    });

    const comments = await continuation.comments(submission);
    await expect(continuation.comments(submission)).resolves.toBe(comments);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/comments/post/_/parent",
      params: { limit: 25, sort: "old" },
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toBeInstanceOf(Comment);
    expect((comments[0] as Comment).body).toBe("continued");
  });

  it("parses direct and wrapped morechildren responses and rejects malformed responses", async () => {
    const submission = new Submission(mockClient().client, "post");
    submission.commentSort = "new";
    const responses: unknown[] = [
      [
        { kind: "t1", data: { id: "c", parent_id: "t3_post" } },
        { kind: "more", data: { children: [], count: 0, parent_id: "t1_c" } },
      ],
      {},
      [{ kind: "t1" }],
      [{ kind: "t3", data: { id: "bad" } }],
    ];
    const { client, request } = mockClient();
    request.mockImplementation(async () => responses.shift());
    const more = new MoreComments(client, { children: ["c"], count: 1 });

    const parsed = await more.comments(submission);
    expect(parsed[0]).toBeInstanceOf(Comment);
    expect(parsed[1]).toBeInstanceOf(MoreComments);
    expect((parsed[0] as Comment & { submission: Submission }).submission).toBe(
      submission,
    );
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      data: { sort: "new" },
    });
    await expect(more.comments(submission)).resolves.toBe(parsed);
    await expect(
      new MoreComments(client, { children: ["missing"], count: 1 }).comments(
        submission,
      ),
    ).rejects.toThrow("no things array");
    await expect(
      new MoreComments(client, { children: ["invalid"], count: 1 }).comments(
        submission,
      ),
    ).rejects.toThrow("invalid thing");
    await expect(
      new MoreComments(client, {
        children: ["unsupported"],
        count: 1,
      }).comments(submission),
    ).rejects.toThrow("unsupported thing");
    await expect(
      new MoreComments(client, { children: [1] }).comments(submission),
    ).rejects.toThrow("must be strings");
    expect(new MoreComments(client).identity).toBe("more:0:");
    expect(more.equals({})).toBe(false);
  });

  it("replaces nested placeholders under their returned parents", async () => {
    const { client, request } = mockClient({
      json: {
        data: {
          things: [
            { kind: "t1", data: { id: "child", parent_id: "t1_parent" } },
            { kind: "t1", data: { id: "grandchild", parent_id: "t1_child" } },
          ],
        },
      },
    });
    const submission = new Submission(client, "post");
    const more = new MoreComments(client, {
      children: ["child"],
      count: 2,
      parent_id: "t1_parent",
    });
    const parent = new Comment(client, {
      id: "parent",
      parent_id: "t3_post",
      replies: [more, "ignored"],
    });
    const forest = new CommentForest(submission, [parent]);

    expect(forest.length).toBe(1);
    expect(forest.at(0)).toBe(parent);
    expect([...forest]).toEqual([parent]);
    await expect(forest.replaceMore({ limit: null })).resolves.toEqual([]);

    expect(request).toHaveBeenCalledOnce();
    expect(
      forest
        .list()
        .map((item) =>
          item instanceof Comment ? item.fullname : item.identity,
        ),
    ).toEqual(["t1_parent", "t1_child", "t1_grandchild"]);
    expect(parent.replies).toBeInstanceOf(CommentForest);
  });

  it("applies threshold and zero limits, validates options, and resets after errors", async () => {
    const { client, request } = mockClient([]);
    const submission = new Submission(client, "post");
    const small = new MoreComments(client, { children: ["a"], count: 1 });
    const missingCount = new MoreComments(client, { children: ["b"] });
    const forest = new CommentForest(submission, [small, missingCount]);

    await expect(forest.replaceMore({ threshold: 2 })).resolves.toEqual([
      small,
      missingCount,
    ]);
    expect(request).not.toHaveBeenCalled();
    await expect(
      new CommentForest(submission, [small]).replaceMore({ limit: 0 }),
    ).resolves.toEqual([small]);
    await expect(forest.replaceMore({ limit: -1 })).rejects.toThrow("limit");
    await expect(forest.replaceMore({ limit: 1.5 })).rejects.toThrow("limit");
    await expect(forest.replaceMore({ threshold: -1 })).rejects.toThrow(
      "threshold",
    );
    await expect(forest.replaceMore({ threshold: 0.5 })).rejects.toThrow(
      "threshold",
    );

    const failing = new MoreComments(client, { children: ["x"], count: 1 });
    request.mockRejectedValueOnce(new Error("network"));
    const retryable = new CommentForest(submission, [failing]);
    await expect(retryable.replaceMore()).rejects.toThrow("network");
    request.mockResolvedValueOnce([]);
    await expect(retryable.replaceMore()).resolves.toEqual([]);
  });

  it("rejects concurrent replacement and duplicate returned comments", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const { client, request } = mockClient();
    request.mockReturnValueOnce(pending);
    const submission = new Submission(client, "post");
    const more = new MoreComments(client, { children: ["child"], count: 1 });
    const forest = new CommentForest(submission, [more]);
    const first = forest.replaceMore();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await expect(forest.replaceMore()).rejects.toThrow("concurrently");
    release([]);
    await first;

    const existing = new Comment(client, { id: "same", parent_id: "t3_post" });
    const duplicateMore = new MoreComments(client, {
      children: ["same"],
      count: 1,
    });
    request.mockResolvedValueOnce([
      { kind: "t1", data: { id: "same", parent_id: "t3_post" } },
    ]);
    await expect(
      new CommentForest(submission, [existing, duplicateMore]).replaceMore(),
    ).rejects.toThrow("duplicate comment t1_same");
  });
});

describe("media edge cases", () => {
  it("supports byte overloads, subclasses, extension case, and replay isolation", () => {
    const optionsMedia = new Media(new Uint8Array([1]), {
      name: "PHOTO.JPEG",
      maxSize: 1,
    });
    const namedMedia = new Media(new Uint8Array([2]), "movie.webm");
    const post = PostMedia.fromBytes(new Uint8Array([3]), "still.webp");

    expect(optionsMedia.mimeType).toBe("image/jpeg");
    expect(namedMedia.mimeType).toBe("video/webm");
    expect(post).toBeInstanceOf(PostMedia);
    expect(post.mimeType).toBe("image/webp");
    expect(optionsMedia.validateSize(1)).toBe(optionsMedia);
    const replay = namedMedia.create();
    replay[0] = 9;
    expect(namedMedia.create()[0]).toBe(2);
  });

  it.each([
    () => new Media(new Uint8Array(), { name: "" }),
    () => new Media(new Uint8Array([1]), "x.png", { maxSize: 0 }),
    () => new Media(new Uint8Array(), "x.png", { maxSize: -1 }),
    () =>
      new Media(new Uint8Array(), "x.png", {
        maxSize: Number.MAX_SAFE_INTEGER + 1,
      }),
    () => new Media(new Uint8Array(), "unknown.bin").mimeType,
    () => new Media(new Uint8Array([1]), "x.png").validateSize(0),
  ])("rejects invalid media input %#", (create) => {
    expect(create).toThrow();
  });
});
