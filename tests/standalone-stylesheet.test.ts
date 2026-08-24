import { describe, expect, it, vi } from "vitest";

import type { ReplayableBody } from "../src/core/transport.js";
import {
  Stylesheet,
  SubredditStylesheet,
  createSubredditStylesheet,
} from "../src/domains/stylesheet.js";
import {
  ReadOnlyException,
  RedditAPIException,
  ResponseException,
  ServerError,
} from "../src/exceptions.js";
import type { RedditQueryRequest, RedditRequest } from "../src/models/base.js";
import type { ModerationClientLike } from "../src/models/moderation.js";
import {
  EmojiMedia,
  StylesheetAsset,
  StylesheetImage,
} from "../src/models/public.js";

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
    { name: "key", value: "styles/banner.png" },
    { name: "policy", value: "signed" },
  ],
): unknown {
  return {
    s3UploadLease: {
      action: "//styles.example/upload/",
      fields,
    },
  };
}

const png = (): StylesheetImage =>
  StylesheetImage.fromBytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    "image.png",
  );
const jpg = (): StylesheetImage =>
  StylesheetImage.fromBytes(new Uint8Array([0xff, 0xd8, 0xff]), "image.jpg");
const asset = (): StylesheetAsset =>
  StylesheetAsset.fromBytes(new Uint8Array([0x89]), "banner.png");

describe("standalone stylesheet", () => {
  it("reads and updates stylesheet data", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce({ images: [{ name: "logo" }], stylesheet: "p{}" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ images: [], stylesheet: "a{}" })
      .mockResolvedValueOnce(null);
    const domain = createSubredditStylesheet(client, "type/script");
    const result = await domain.read();
    expect(result).toBeInstanceOf(Stylesheet);
    expect(result.stylesheet).toBe("p{}");
    expect(result.subreddit).toBe("type/script");
    await domain.update("a{}", {
      reason: "refresh",
      signal: new AbortController().signal,
    });
    await expect(domain.get()).resolves.toBeInstanceOf(Stylesheet);
    await domain.update("b{}");
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/r/type%2Fscript/about/stylesheet/",
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      data: { op: "save", reason: "refresh", stylesheet_contents: "a{}" },
      method: "POST",
      path: "/r/type%2Fscript/api/subreddit_stylesheet/",
    });
  });

  it("uploads named, header, mobile header, and icon images", async () => {
    const { client, request } = setup();
    request.mockResolvedValue({
      errors: [],
      img_src: "https://example.com/image.png",
    });
    const domain = new SubredditStylesheet(client, "test");
    await expect(domain.upload(png(), "logo")).resolves.toMatchObject({
      img_src: expect.any(String),
    });
    await domain.uploadHeader(jpg());
    await domain.uploadMobileHeader(png());
    await domain.uploadMobileIcon(png());

    const texts = request.mock.calls.map(({ 0: call }) => {
      const body = (call as RedditRequest).data as ReplayableBody;
      const first = body.create() as Uint8Array;
      expect(Array.from(first)).toEqual(
        Array.from(body.create() as Uint8Array),
      );
      return new TextDecoder().decode(first);
    });
    expect(texts[0]).toContain('name="name"\r\n\r\nlogo');
    expect(texts[0]).toContain('name="upload_type"\r\n\r\nimg');
    expect(texts[0]).toContain('name="img_type"\r\n\r\npng');
    expect(texts[1]).toContain('name="img_type"\r\n\r\njpg');
    expect(texts[1]).toContain('name="upload_type"\r\n\r\nheader');
    expect(texts[2]).toContain('name="upload_type"\r\n\r\nbanner');
    expect(texts[3]).toContain('name="upload_type"\r\n\r\nicon');
    expect(
      request.mock.calls.every(
        ({ 0: call }) => call.path === "/r/test/api/upload_sr_img",
      ),
    ).toBe(true);
  });

  it("maps named image errors and malformed responses", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce({
        errors: ["IMAGE_ERROR"],
        errors_values: ["bad image"],
      })
      .mockResolvedValueOnce({ errors: ["IMAGE_ERROR"] })
      .mockResolvedValueOnce({ errors: [1] })
      .mockResolvedValueOnce({ nope: true });
    const domain = createSubredditStylesheet(client, "test");
    const error = await domain
      .upload(png(), "logo")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RedditAPIException);
    expect(error).toHaveProperty("items.0.message", "bad image");
    await expect(domain.upload(png(), "logo")).rejects.toHaveProperty(
      "items.0.message",
      null,
    );
    await expect(domain.upload(png(), "logo")).rejects.toThrow("error data");
    await expect(domain.upload(png(), "logo")).rejects.toThrow(
      "invalid stylesheet image data",
    );
  });

  it("leases all redesign assets, uploads externally, and patches styles", async () => {
    const { client, request } = setup();
    for (let index = 0; index < 4; index += 1) {
      request
        .mockResolvedValueOnce(lease())
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce(null);
    }
    const domain = createSubredditStylesheet(client, "test");
    await domain.uploadBanner(asset());
    await domain.uploadBannerAdditionalImage(asset(), { align: "centered" });
    await domain.uploadBannerHoverImage(asset());
    await domain.uploadMobileBanner(asset());

    const types = [
      "bannerBackgroundImage",
      "bannerPositionedImage",
      "secondaryBannerPositionedImage",
      "mobileBannerImage",
    ];
    for (const [index, type] of types.entries()) {
      const leaseRequest = request.mock.calls[index * 3]?.[0];
      expect(leaseRequest).toMatchObject({
        data: {
          filepath: "banner.png",
          imagetype: type,
          mimetype: "image/png",
        },
        method: "POST",
        path: "/api/v1/style_asset_upload_s3/test",
      });
      const upload = request.mock.calls[index * 3 + 1]?.[0] as RedditRequest;
      expect(upload).toMatchObject({
        auth: false,
        path: "https://styles.example/upload/",
        rawJson: false,
        responseType: "text",
      });
      const body = upload.data as ReplayableBody;
      expect(Array.from(body.create() as Uint8Array)).toEqual(
        Array.from(body.create() as Uint8Array),
      );
      expect(request.mock.calls[index * 3 + 2]?.[0]).toMatchObject({
        data: { [type]: "https://styles.example/upload/styles/banner.png" },
        method: "PATCH",
        path: "/api/v1/structured_styles/test",
      });
    }
    expect((request.mock.calls[5]?.[0] as RedditRequest).data).toMatchObject({
      bannerPositionedImagePosition: "centered",
    });
  });

  it("supports absolute lease URLs and default additional-image alignment", async () => {
    const { client, request } = setup();
    const absoluteLease = {
      s3UploadLease: {
        action: "https://styles.example/plain",
        fields: [{ name: "key", value: "asset.png" }],
      },
    };
    request
      .mockResolvedValueOnce(absoluteLease)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(null);
    await createSubredditStylesheet(client, "test").uploadBannerAdditionalImage(
      asset(),
    );
    expect(request.mock.calls[1]?.[0].path).toBe(
      "https://styles.example/plain",
    );
    expect((request.mock.calls[2]?.[0] as RedditRequest).data).toEqual({
      bannerPositionedImage: "https://styles.example/plain/asset.png",
    });
  });

  it("deletes named and standard assets with the expected payloads", async () => {
    const { client, request } = setup();
    const signal = new AbortController().signal;
    const domain = createSubredditStylesheet(client, "test");
    await domain.deleteImage("logo", signal);
    await domain.deleteHeader(signal);
    await domain.deleteMobileHeader(signal);
    await domain.deleteMobileIcon(signal);
    await domain.deleteBanner(signal);
    await domain.deleteBannerAdditionalImage(signal);
    await domain.deleteBannerHoverImage(signal);
    await domain.deleteMobileBanner(signal);

    expect(request).toHaveBeenNthCalledWith(1, {
      data: { img_name: "logo" },
      method: "POST",
      path: "/r/test/api/delete_sr_img",
      signal,
    });
    expect(
      request.mock.calls.slice(1, 3).map(({ 0: call }) => call.path),
    ).toEqual(["/r/test/api/delete_sr_header", "/r/test/api/delete_sr_header"]);
    expect(request.mock.calls[3]?.[0].path).toBe("/r/test/api/delete_sr_icon");
    expect(
      request.mock.calls
        .slice(4)
        .map(({ 0: call }): unknown => (call as RedditRequest).data),
    ).toEqual([
      { bannerBackgroundImage: "" },
      { bannerPositionedImage: "", secondaryBannerPositionedImage: "" },
      { secondaryBannerPositionedImage: "" },
      { mobileBannerImage: "" },
    ]);
  });

  it("enforces read-only mode, names, media classes, and cancellation", async () => {
    const blocked = setup(true);
    const domain = createSubredditStylesheet(blocked.client, "test");
    await expect(domain.update("p{}")).rejects.toBeInstanceOf(
      ReadOnlyException,
    );
    await expect(domain.deleteBanner()).rejects.toBeInstanceOf(
      ReadOnlyException,
    );
    await expect(domain.upload(png(), "logo")).rejects.toBeInstanceOf(
      ReadOnlyException,
    );

    const { client, request } = setup();
    const active = createSubredditStylesheet(client, "test");
    expect(() => active.upload(png(), " ")).toThrow(
      "image name cannot be empty",
    );
    await expect(
      active.upload(
        EmojiMedia.fromBytes(new Uint8Array(), "x.png") as StylesheetImage,
        "x",
      ),
    ).rejects.toThrow("StylesheetImage");
    await expect(
      active.uploadBanner(png() as unknown as StylesheetAsset),
    ).rejects.toThrow("StylesheetAsset");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(active.read(controller.signal)).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
    expect(() => createSubredditStylesheet(client, " ")).toThrow(
      "subreddit cannot be empty",
    );
  });

  it("rejects malformed reads and leases", async () => {
    const { client, request } = setup();
    request.mockResolvedValueOnce(null);
    await expect(
      createSubredditStylesheet(client, "test").read(),
    ).rejects.toThrow("invalid stylesheet data");

    for (const response of [
      {},
      { s3UploadLease: { action: 1, fields: [] } },
      lease([null]),
      lease([{ name: "policy", value: "x" }]),
    ]) {
      const current = setup();
      current.request.mockResolvedValueOnce(response).mockResolvedValueOnce("");
      await expect(
        createSubredditStylesheet(current.client, "test").uploadBanner(asset()),
      ).rejects.toThrow(/lease response/);
    }
  });

  it("maps external response errors and propagates timeout/cancellation errors", async () => {
    const failed = setup();
    failed.request
      .mockResolvedValueOnce(lease())
      .mockRejectedValueOnce(new ResponseException({ status: 403 }));
    await expect(
      createSubredditStylesheet(failed.client, "test").uploadBanner(asset()),
    ).rejects.toBeInstanceOf(ServerError);

    const timeout = setup();
    const timeoutError = new Error("request timed out");
    timeout.request
      .mockResolvedValueOnce(lease())
      .mockRejectedValueOnce(timeoutError);
    await expect(
      createSubredditStylesheet(timeout.client, "test").uploadBanner(asset()),
    ).rejects.toBe(timeoutError);
  });
});
