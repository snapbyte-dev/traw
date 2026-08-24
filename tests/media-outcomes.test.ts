import { describe, expect, it, vi } from "vitest";

import {
  nodeWebSocketFactory,
  type WebSocketFactory,
  type WebSocketLike,
} from "../src/core/transport.js";
import { MediaPostFailedError, WebSocketError } from "../src/exceptions.js";
import { Submission, Subreddit } from "../src/models/entities.js";
import {
  InlineGif,
  InlineImage,
  InlineVideo,
  PostMedia,
} from "../src/models/media.js";
import type {
  RedditClientLike,
  RedditQueryRequest,
  RedditRequest,
} from "../src/models/base.js";

type ModelRequest = RedditRequest | RedditQueryRequest;

function lease(assetId: string) {
  return {
    args: {
      action: "//uploads.example",
      fields: [{ name: "key", value: `media/${assetId}` }],
    },
    asset: { asset_id: assetId },
  };
}

class FakeWebSocket implements WebSocketLike {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  closed = false;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "close" | "error" | "message", event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function socketFactory(update?: unknown): {
  factory: WebSocketFactory;
  socket: FakeWebSocket;
} {
  const socket = new FakeWebSocket();
  const factory = vi.fn<WebSocketFactory>(() => {
    if (update !== undefined)
      queueMicrotask(() => socket.emit("message", { data: update }));
    return socket;
  });
  return { factory, socket };
}

async function waitForFactory(factory: WebSocketFactory): Promise<void> {
  const mock = vi.mocked(factory);
  while (mock.mock.calls.length === 0) await Promise.resolve();
}

describe("inline self-post media", () => {
  it("renders typed media, uses selfpost asset IDs, and submits rich text", async () => {
    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    let asset = 0;
    request.mockImplementation(async ({ path }) => {
      if (path === "/api/media/asset.json") return lease(`asset-${++asset}`);
      if (path === "https://uploads.example") return "";
      if (path === "/api/convert_rte_body_format")
        return { output: { document: [{ e: "par", c: "converted" }] } };
      return { id: "created" };
    });
    const client: RedditClientLike = { request };
    const gif = new InlineGif({
      caption: "moving",
      media: PostMedia.fromBytes(new Uint8Array([1]), "moving.gif"),
    });
    const image = new InlineImage({
      media: PostMedia.fromBytes(new Uint8Array([2]), "still.png"),
    });
    const video = new InlineVideo({
      caption: "clip",
      media: PostMedia.fromBytes(new Uint8Array([3]), "clip.mp4"),
    });

    await new Subreddit(client, "test").submit("inline", {
      inlineMedia: { gif1: gif, image1: image, video1: video },
      kind: "text",
      selftext: "A {gif1} B {image1} C {video1}",
    });

    expect([gif.mediaId, image.mediaId, video.mediaId]).toEqual([
      "asset-1",
      "asset-2",
      "asset-3",
    ]);
    const conversion = request.mock.calls.find(
      ([call]) => call.path === "/api/convert_rte_body_format",
    )![0] as RedditRequest;
    expect(conversion.data).toEqual({
      markdown_text:
        'A \n\n![gif](asset-1 "moving")\n\n B \n\n![img](asset-2 "")\n\n C \n\n![video](asset-3 "clip")\n\n',
      output_mode: "rtjson",
    });
    const submit = request.mock.calls.find(
      ([call]) => call.path === "/api/submit",
    )![0] as RedditRequest;
    expect(submit.data).toMatchObject({
      kind: "self",
      richtext_json: JSON.stringify({
        document: [{ e: "par", c: "converted" }],
      }),
    });
    expect(submit.data).not.toHaveProperty("text");
  });

  it("supports rich-text submission edits", async () => {
    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    request
      .mockResolvedValueOnce(lease("edit-media"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce({ output: { document: [] } })
      .mockResolvedValueOnce({ id: "post", selftext: "updated" });
    const submission = new Submission({ request }, { id: "post" });

    await expect(
      submission.edit("new {photo}", {
        inlineMedia: {
          photo: new InlineImage({
            media: PostMedia.fromBytes(new Uint8Array([1]), "photo.jpg"),
          }),
        },
      }),
    ).resolves.toBe(submission);

    expect(request).toHaveBeenLastCalledWith({
      data: {
        richtext_json: JSON.stringify({ document: [] }),
        thing_id: "t3_post",
        validate_on_submit: true,
      },
      method: "POST",
      path: "/api/editusertext",
    });
    expect(submission.selftext).toBe("updated");
  });

  it("rejects invalid media classes and placeholder keys before upload", async () => {
    const png = PostMedia.fromBytes(new Uint8Array(), "still.png");
    const gif = PostMedia.fromBytes(new Uint8Array(), "moving.gif");
    const video = PostMedia.fromBytes(new Uint8Array(), "clip.mp4");
    expect(() => new InlineGif({ media: png })).toThrow("image/gif");
    expect(() => new InlineImage({ media: gif })).toThrow("non-GIF");
    expect(() => new InlineVideo({ media: png })).toThrow("video MIME");
    expect(
      () =>
        new InlineImage({
          media: {} as PostMedia,
        }),
    ).toThrow("PostMedia");
    expect(new InlineImage({ media: png }).toString()).toBe(
      '\n\n![img]( "")\n\n',
    );

    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    const subreddit = new Subreddit({ request }, "test");
    await expect(
      subreddit.submit("empty", {
        inlineMedia: {},
        kind: "text",
        selftext: "empty",
      }),
    ).rejects.toThrow("at least one");
    await expect(
      subreddit.submit("bad", {
        inlineMedia: { "bad-key": new InlineVideo({ media: video }) },
        kind: "text",
        selftext: "{bad-key}",
      }),
    ).rejects.toThrow("placeholder key");
    await expect(
      subreddit.submit("missing", {
        inlineMedia: { clip: new InlineVideo({ media: video }) },
        kind: "text",
        selftext: "no placeholder",
      }),
    ).rejects.toThrow("missing from body");
    await expect(
      subreddit.submit("invalid", {
        inlineMedia: { photo: {} as InlineImage },
        kind: "text",
        selftext: "{photo}",
      }),
    ).rejects.toThrow("not InlineMedia");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed rich-text conversion responses", async () => {
    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    request
      .mockResolvedValueOnce(lease("photo"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce({});
    await expect(
      new Subreddit({ request }, "test").submit("bad conversion", {
        inlineMedia: {
          photo: new InlineImage({
            media: PostMedia.fromBytes(new Uint8Array(), "photo.png"),
          }),
        },
        kind: "text",
        selftext: "{photo}",
      }),
    ).rejects.toThrow("missing output");
  });
});

describe("media post WebSocket completion", () => {
  it("uses the Node 22 standards-compatible WebSocket constructor", () => {
    const socket = new FakeWebSocket();
    const WebSocketMock = vi.fn(function () {
      return socket;
    });
    vi.stubGlobal("WebSocket", WebSocketMock);
    try {
      expect(nodeWebSocketFactory("wss://media.example")).toBe(socket);
      expect(WebSocketMock).toHaveBeenCalledWith("wss://media.example");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  function mediaClient(
    submitResponse: unknown,
    factory: WebSocketFactory,
  ): RedditClientLike {
    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    request.mockImplementation(async ({ auth, path }) => {
      if (path === "/api/media/asset.json") return lease("image");
      if (auth === false) return "";
      return submitResponse;
    });
    return { request, webSocketFactory: factory };
  }

  it("returns the submission after a successful processing update", async () => {
    const { factory, socket } = socketFactory(
      JSON.stringify({
        payload: { redirect: "https://reddit.com/r/test/comments/abc/title/" },
        type: "success",
      }),
    );
    const client = mediaClient(
      { json: { data: { websocket_url: "wss://media.example/status" } } },
      factory,
    );

    const result = await new Subreddit(client, "test").submit("image", {
      image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
      kind: "image",
      timeoutMs: 100,
    });

    expect(result).toBeInstanceOf(Submission);
    expect(String(result)).toBe("abc");
    expect(factory).toHaveBeenCalledWith("wss://media.example/status");
    expect(socket.closed).toBe(true);
  });

  it("maps Reddit failure and malformed updates to media exceptions", async () => {
    const failed = socketFactory(JSON.stringify({ type: "failed" }));
    await expect(
      new Subreddit(
        mediaClient(
          { json: { data: { websocket_url: "wss://failed" } } },
          failed.factory,
        ),
        "test",
      ).submit("video", {
        kind: "video",
        video: PostMedia.fromBytes(new Uint8Array([1]), "clip.mp4"),
      }),
    ).rejects.toBeInstanceOf(MediaPostFailedError);

    const malformed = socketFactory("not json");
    await expect(
      new Subreddit(
        mediaClient(
          { json: { data: { websocket_url: "wss://malformed" } } },
          malformed.factory,
        ),
        "test",
      ).submit("image", {
        image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
        kind: "image",
      }),
    ).rejects.toBeInstanceOf(WebSocketError);
  });

  it("accepts binary updates and rejects malformed redirects", async () => {
    const update = JSON.stringify({
      payload: { redirect: "https://redd.it/binary" },
      type: "success",
    });
    const bytes = new TextEncoder().encode(update);
    const binary = socketFactory(bytes.buffer);
    await expect(
      new Subreddit(
        mediaClient(
          { data: { websocket_url: "wss://binary" } },
          binary.factory,
        ),
        "test",
      ).submit("image", {
        image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
        kind: "image",
      }),
    ).resolves.toMatchObject({ id: "binary" });

    for (const redirect of ["not a url", "https://reddit.com/"]) {
      const malformed = socketFactory({
        payload: { redirect },
        type: "success",
      });
      await expect(
        new Subreddit(
          mediaClient(
            { json: { data: { websocket_url: "wss://redirect" } } },
            malformed.factory,
          ),
          "test",
        ).submit("image", {
          image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
          kind: "image",
        }),
      ).rejects.toBeInstanceOf(WebSocketError);
    }
  });

  it("maps connection setup, premature close, and missing payload failures", async () => {
    const throwing: WebSocketFactory = () => {
      throw new Error("unavailable");
    };
    await expect(
      new Subreddit(
        mediaClient(
          { json: { data: { websocket_url: "wss://throw" } } },
          throwing,
        ),
        "test",
      ).submit("image", {
        image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
        kind: "image",
      }),
    ).rejects.toThrow("establish");

    const closing = socketFactory();
    const closed = new Subreddit(
      mediaClient(
        { json: { data: { websocket_url: "wss://close" } } },
        closing.factory,
      ),
      "test",
    ).submit("image", {
      image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
      kind: "image",
    });
    const closedAssertion = expect(closed).rejects.toThrow("closed before");
    await waitForFactory(closing.factory);
    closing.socket.emit("close");
    await closedAssertion;

    const missing = socketFactory({ type: "success" });
    await expect(
      new Subreddit(
        mediaClient(
          { json: { data: { websocket_url: "wss://missing" } } },
          missing.factory,
        ),
        "test",
      ).submit("image", {
        image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
        kind: "image",
      }),
    ).rejects.toThrow("missing a media post redirect");
  });

  it("supports timeout, abort, socket errors, and disabling WebSockets", async () => {
    vi.useFakeTimers();
    try {
      const idle = socketFactory();
      const timeout = new Subreddit(
        mediaClient(
          { json: { data: { websocket_url: "wss://idle" } } },
          idle.factory,
        ),
        "test",
      ).submit("image", {
        image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
        kind: "image",
        timeoutMs: 5,
      });
      const timedOut = expect(timeout).rejects.toThrow("timed out");
      await waitForFactory(idle.factory);
      await vi.advanceTimersByTimeAsync(5);
      await timedOut;
      expect(idle.socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const aborting = socketFactory();
    const controller = new AbortController();
    const aborted = new Subreddit(
      mediaClient(
        { json: { data: { websocket_url: "wss://abort" } } },
        aborting.factory,
      ),
      "test",
    ).submit("image", {
      image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
      kind: "image",
      signal: controller.signal,
    });
    await waitForFactory(aborting.factory);
    controller.abort("cancelled");
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    const broken = socketFactory();
    const socketError = new Subreddit(
      mediaClient(
        { json: { data: { websocket_url: "wss://error" } } },
        broken.factory,
      ),
      "test",
    ).submit("image", {
      image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
      kind: "image",
    });
    await waitForFactory(broken.factory);
    broken.socket.emit("error");
    await expect(socketError).rejects.toBeInstanceOf(WebSocketError);

    const disabled = socketFactory();
    const response = { json: { data: { websocket_url: "wss://disabled" } } };
    await expect(
      new Subreddit(mediaClient(response, disabled.factory), "test").submit(
        "image",
        {
          image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
          kind: "image",
          withoutWebSockets: true,
        },
      ),
    ).resolves.toBe(response);
    expect(disabled.factory).not.toHaveBeenCalled();

    expect(() =>
      new Subreddit(mediaClient(null, disabled.factory), "test").submit(
        "image",
        {
          image: PostMedia.fromBytes(new Uint8Array([1]), "image.png"),
          kind: "image",
          timeoutMs: Number.POSITIVE_INFINITY,
        },
      ),
    ).toThrow("timeoutMs");
  });
});
