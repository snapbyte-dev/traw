import { describe, expect, it, vi } from "vitest";

import type { ReplayableBody } from "../src/core/transport.js";
import {
  Emoji,
  SubredditEmoji,
  type EmojiUploadOptions,
} from "../src/domains/emoji.js";
import {
  ReadOnlyError,
  ResponseError,
  ServerError,
} from "../src/exceptions.js";
import type { RedditQueryRequest, RedditRequest } from "../src/models/base.js";
import type { ModerationClientLike } from "../src/models/moderation.js";
import { EmojiMedia, StylesheetImage } from "../src/models/media.js";

type Request = RedditRequest | RedditQueryRequest;

function setup(readOnly = false): {
  client: ModerationClientLike;
  request: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>>;
} {
  const request = vi.fn<(request: Request) => Promise<unknown>>();
  request.mockResolvedValue(null);
  return { client: { readOnly, request }, request };
}

function lease(
  fields: unknown[] = [
    { name: "key", value: "emoji/key.png" },
    { name: "policy", value: "signed" },
  ],
): unknown {
  return {
    s3UploadLease: {
      action: "//emoji-bucket.example/upload",
      fields,
    },
  };
}

function media(): EmojiMedia {
  return EmojiMedia.fromBytes(new Uint8Array([137, 80, 78, 71]), "emoji.png");
}

describe("standalone emoji", () => {
  it("lists emoji, creates lazy references, and refreshes them", async () => {
    const { client, request } = setup();
    request.mockResolvedValue({
      t5_community: {
        party: {
          mod_flair_only: false,
          post_flair_allowed: true,
          url: "https://example.com/party.png",
          user_flair_allowed: true,
        },
      },
    });
    const emojis = new SubredditEmoji(client, "typescript");

    const [listed] = await emojis.list();
    expect(listed).toBeInstanceOf(Emoji);
    expect(String(listed)).toBe("party");
    expect(listed?.url).toBe("https://example.com/party.png");
    const lazy = emojis.get("party");
    await expect(lazy.refresh()).resolves.toBe(lazy);
    expect(lazy.post_flair_allowed).toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/v1/typescript/emojis/all",
    });
  });

  it("leases and replayably uploads media before creating the emoji", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce(lease())
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(null);
    const signal = new AbortController().signal;
    const options: EmojiUploadOptions = {
      media: media(),
      modFlairOnly: true,
      name: "party",
      postFlairAllowed: false,
      userFlairAllowed: true,
    };

    const emoji = await new SubredditEmoji(client, "type/script").upload(
      options,
      signal,
    );
    expect(emoji).toBeInstanceOf(Emoji);
    expect(String(emoji)).toBe("party");
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/v1/type%2Fscript/emoji_asset_upload_s3.json",
      data: { filepath: "emoji.png", mimetype: "image/png" },
      signal,
    });
    const upload = request.mock.calls[1]![0] as RedditRequest;
    expect(upload).toMatchObject({
      auth: false,
      method: "POST",
      path: "https://emoji-bucket.example/upload",
      rawJson: false,
      responseType: "text",
      signal,
    });
    const body = upload.data as ReplayableBody;
    expect(Array.from(body.create() as Uint8Array)).toEqual(
      Array.from(body.create() as Uint8Array),
    );
    expect(new TextDecoder().decode(body.create() as Uint8Array)).toContain(
      'name="policy"\r\n\r\nsigned',
    );
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "POST",
      path: "/api/v1/type%2Fscript/emoji.json",
      data: {
        mod_flair_only: true,
        name: "party",
        post_flair_allowed: false,
        s3_key: "emoji/key.png",
        user_flair_allowed: true,
      },
      signal,
    });
  });

  it("supports add and collection update/delete aliases", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce(lease())
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        t5_test: {
          party: {
            mod_flair_only: false,
            post_flair_allowed: true,
            user_flair_allowed: true,
          },
        },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const emojis = new SubredditEmoji(client, "test");
    await emojis.upload({ media: media(), name: "new" });
    const updated = await emojis.update("party", { modFlairOnly: true });
    expect(updated.mod_flair_only).toBe(true);
    await emojis.delete("party");
    expect(request).toHaveBeenNthCalledWith(5, {
      method: "POST",
      path: "/api/v1/test/emoji_permissions",
      data: {
        mod_flair_only: true,
        name: "party",
        post_flair_allowed: true,
        user_flair_allowed: true,
      },
    });
    expect(request).toHaveBeenNthCalledWith(6, {
      method: "DELETE",
      path: "/api/v1/test/emoji/party",
    });
  });

  it("updates loaded emoji without an extra read", async () => {
    const { client, request } = setup();
    const emoji = new Emoji(client, "test", {
      mod_flair_only: false,
      name: "party",
      post_flair_allowed: false,
      user_flair_allowed: false,
    });
    await emoji.update({
      modFlairOnly: true,
      postFlairAllowed: true,
      userFlairAllowed: true,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(emoji.raw).toMatchObject({
      mod_flair_only: true,
      post_flair_allowed: true,
      user_flair_allowed: true,
    });
  });

  it("rejects invalid list and model data", async () => {
    const { client, request } = setup();
    for (const response of [
      null,
      {},
      { t5_a: {}, t5_b: {} },
      { t5_a: { bad: 1 } },
    ]) {
      request.mockResolvedValueOnce(response);
      await expect(new SubredditEmoji(client, "test").list()).rejects.toThrow(
        "invalid emoji data",
      );
    }
    expect(() => new Emoji(client, "test", {})).toThrow("valid name");
    expect(() => new Emoji(client, "test", { name: "" }).toString()).toThrow(
      "valid name",
    );
    expect(() => new SubredditEmoji(client, " ")).toThrow(
      "subreddit cannot be empty",
    );
    expect(() => new SubredditEmoji(client, "test").get(" ")).toThrow(
      "emoji name cannot be empty",
    );
  });

  it("rejects absent and incomplete emoji during partial updates", async () => {
    const { client, request } = setup();
    request.mockResolvedValueOnce({ t5_test: {} });
    await expect(
      new SubredditEmoji(client, "test")
        .get("missing")
        .update({ modFlairOnly: true }),
    ).rejects.toThrow("does not have the emoji missing");

    request.mockResolvedValueOnce({
      t5_test: { party: { mod_flair_only: false } },
    });
    await expect(
      new SubredditEmoji(client, "test")
        .get("party")
        .update({ modFlairOnly: true }),
    ).rejects.toThrow("no valid post_flair_allowed");
    await expect(
      new SubredditEmoji(client, "test").get("party").update({}),
    ).rejects.toThrow("At least one");
  });

  it("enforces authorization, media types, and cancellation before requests", async () => {
    const blocked = setup(true);
    await expect(
      new SubredditEmoji(blocked.client, "test").upload({
        media: media(),
        name: "x",
      }),
    ).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(
      new SubredditEmoji(blocked.client, "test").get("x").delete(),
    ).rejects.toBeInstanceOf(ReadOnlyError);

    const { client, request } = setup();
    await expect(
      new SubredditEmoji(client, "test").upload({
        media: StylesheetImage.fromBytes(
          new Uint8Array(),
          "x.png",
        ) as EmojiMedia,
        name: "x",
      }),
    ).rejects.toThrow("EmojiMedia");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      new SubredditEmoji(client, "test").list(controller.signal),
    ).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed leases and maps S3 response failures", async () => {
    const malformed = [
      {},
      { s3UploadLease: { action: 1, fields: [] } },
      lease([null]),
      lease([{ name: "policy", value: "x" }]),
    ];
    for (const response of malformed) {
      const { client, request } = setup();
      request.mockResolvedValueOnce(response).mockResolvedValueOnce("");
      await expect(
        new SubredditEmoji(client, "test").upload({
          media: media(),
          name: "x",
        }),
      ).rejects.toThrow(/lease response/);
    }

    const failed = setup();
    failed.request
      .mockResolvedValueOnce(lease())
      .mockRejectedValueOnce(new ResponseError({ status: 403 }));
    await expect(
      new SubredditEmoji(failed.client, "test").upload({
        media: media(),
        name: "x",
      }),
    ).rejects.toBeInstanceOf(ServerError);

    const timeout = setup();
    const timeoutError = new Error("request timed out");
    timeout.request
      .mockResolvedValueOnce(lease())
      .mockRejectedValueOnce(timeoutError);
    await expect(
      new SubredditEmoji(timeout.client, "test").upload({
        media: media(),
        name: "x",
      }),
    ).rejects.toBe(timeoutError);
  });
});
