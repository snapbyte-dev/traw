import { describe, expect, it, vi } from "vitest";

import type { ReplayableBody } from "../src/core/transport.js";
import {
  ResponseException,
  ServerError,
  TooLargeMediaException,
} from "../src/exceptions.js";
import type {
  RedditClientLike,
  RedditQueryRequest,
  RedditRequest,
} from "../src/models/base.js";
import { PostMedia } from "../src/models/media.js";

type ModelRequest = RedditRequest | RedditQueryRequest;

function lease(assetId = "asset-id") {
  return {
    args: {
      action: "//bucket.example/upload",
      fields: [
        { name: "key", value: "assets/photo.png" },
        { name: "x-amz-credential", value: "credential" },
        { name: "policy", value: "signed-policy" },
      ],
    },
    asset: { asset_id: assetId },
  };
}

describe("PostMedia upload", () => {
  it("leases, uploads all S3 fields and bytes, and returns the asset URL", async () => {
    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    request.mockResolvedValueOnce(lease()).mockResolvedValueOnce("");
    const client: RedditClientLike = { request };
    const media = PostMedia.fromBytes(
      new Uint8Array([137, 80, 78, 71]),
      "photo.png",
    );

    await expect(media.upload(client)).resolves.toBe(
      "https://bucket.example/upload/assets/photo.png",
    );
    expect(request).toHaveBeenNthCalledWith(1, {
      data: { filepath: "photo.png", mimetype: "image/png" },
      method: "POST",
      path: "/api/media/asset.json",
    });
    const upload = request.mock.calls[1]![0] as RedditRequest;
    expect(upload).toMatchObject({
      auth: false,
      method: "POST",
      path: "https://bucket.example/upload",
      rawJson: false,
      responseType: "text",
    });
    const body = upload.data as ReplayableBody;
    const first = body.create() as Uint8Array;
    const second = body.create() as Uint8Array;
    const text = new TextDecoder().decode(first);
    expect(body.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(text).toContain('name="key"\r\n\r\nassets/photo.png');
    expect(text).toContain('name="x-amz-credential"\r\n\r\ncredential');
    expect(text).toContain('filename="photo.png"\r\nContent-Type: image/png');
    expect(Array.from(first)).toEqual(
      expect.arrayContaining([137, 80, 78, 71]),
    );
  });

  it("returns an asset ID for gallery uploads", async () => {
    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    request
      .mockResolvedValueOnce(lease("gallery-id"))
      .mockResolvedValueOnce("");
    await expect(
      PostMedia.fromBytes(new Uint8Array([1]), "photo.webp").upload(
        { request },
        { expectedMimePrefix: "image", uploadType: "gallery" },
      ),
    ).resolves.toBe("gallery-id");
  });

  it("rejects wrong media types before requesting a lease", async () => {
    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    await expect(
      PostMedia.fromBytes(new Uint8Array(), "clip.mp4").upload(
        { request },
        { expectedMimePrefix: "image" },
      ),
    ).rejects.toThrow("Expected a MIME type starting with image");
    expect(request).not.toHaveBeenCalled();
  });

  it("maps S3 size XML to TooLargeMediaException", async () => {
    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    request.mockResolvedValueOnce(lease()).mockRejectedValueOnce(
      new ResponseException({
        body: "<Error><Code>EntityTooLarge</Code><Message>large</Message><ProposedSize>11</ProposedSize><MaxSizeAllowed>10</MaxSizeAllowed></Error>",
        status: 400,
      }),
    );
    const error = await PostMedia.fromBytes(new Uint8Array([1]), "photo.jpg")
      .upload({ request })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TooLargeMediaException);
    expect(error).toMatchObject({ actual: 11, maximumSize: 10 });
  });

  it("rejects malformed leases and maps other S3 responses to ServerError", async () => {
    const malformed = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    malformed.mockResolvedValue({ args: { action: "//bucket", fields: [] } });
    await expect(
      PostMedia.fromBytes(new Uint8Array(), "photo.png").upload({
        request: malformed,
      }),
    ).rejects.toThrow("malformed");

    const request = vi.fn<(request: ModelRequest) => Promise<unknown>>();
    request
      .mockResolvedValueOnce(lease())
      .mockRejectedValueOnce(new ResponseException({ status: 403 }));
    await expect(
      PostMedia.fromBytes(new Uint8Array(), "photo.png").upload({ request }),
    ).rejects.toBeInstanceOf(ServerError);
  });
});
