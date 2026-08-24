import { replayableMultipart } from "../core/transport.js";
import { RedditApiError, ResponseError, ServerError } from "../exceptions.js";
import { BaseModel, isRawData, type RawData } from "../models/base.js";
import { StylesheetAsset, StylesheetImage } from "../models/media.js";
import {
  assertModeratorAccess,
  requiredString,
  subredditName,
  subredditPath,
  type ModerationClientLike,
  type SubredditReference,
} from "../models/moderation.js";

export type BannerAlignment = "centered" | "left" | "right";

interface UploadLease {
  readonly fields: readonly (readonly [string, string])[];
  readonly url: string;
}

function parseLease(value: unknown): UploadLease {
  if (!isRawData(value) || !isRawData(value["s3UploadLease"])) {
    throw new TypeError(
      "stylesheet asset lease response is missing s3UploadLease",
    );
  }
  const lease = value["s3UploadLease"];
  const action = lease["action"];
  const rawFields = lease["fields"];
  if (typeof action !== "string" || !Array.isArray(rawFields)) {
    throw new TypeError("stylesheet asset lease response is malformed");
  }
  const fields = rawFields.map((field): readonly [string, string] => {
    if (
      !isRawData(field) ||
      typeof field["name"] !== "string" ||
      typeof field["value"] !== "string"
    ) {
      throw new TypeError(
        "stylesheet asset lease response contains a malformed field",
      );
    }
    return [field["name"], field["value"]];
  });
  return {
    fields,
    url: action.startsWith("//") ? `https:${action}` : action,
  };
}

function uploadFailure(error: unknown): never {
  if (!(error instanceof ResponseError)) throw error;
  throw new ServerError(error.response);
}

function imageType(media: StylesheetImage): "jpg" | "png" {
  const bytes = media.create();
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? "jpg"
    : "png";
}

function imageResponse(value: unknown): RawData {
  if (!isRawData(value) || !Array.isArray(value["errors"])) {
    throw new TypeError("Reddit returned invalid stylesheet image data");
  }
  const errors = value["errors"];
  if (errors.length > 0) {
    const error: unknown = errors[0];
    const values = value["errors_values"];
    const message: unknown = Array.isArray(values) ? values[0] : undefined;
    if (typeof error !== "string") {
      throw new TypeError(
        "Reddit returned invalid stylesheet image error data",
      );
    }
    throw new RedditApiError([
      error,
      typeof message === "string" ? message : null,
      null,
    ]);
  }
  return value;
}

export class Stylesheet extends BaseModel {
  readonly subreddit: SubredditReference;
  declare images: unknown;
  declare stylesheet: unknown;

  constructor(
    client: ModerationClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    super(client, data);
    this.subreddit = subreddit;
    subredditName(subreddit);
  }
}

export class SubredditStylesheet {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.#client = client;
    this.#subreddit = subreddit;
    subredditName(subreddit);
  }

  async get(signal?: AbortSignal): Promise<Stylesheet> {
    signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: `/r/${subredditPath(this.#subreddit)}/about/stylesheet/`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!isRawData(response)) {
      throw new TypeError("Reddit returned invalid stylesheet data");
    }
    return new Stylesheet(this.#client, this.#subreddit, response);
  }

  async update(
    stylesheet: string,
    options: { readonly reason?: string; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    assertModeratorAccess(this.#client, "stylesheet.update()");
    options.signal?.throwIfAborted();
    await this.#client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#subreddit)}/api/subreddit_stylesheet/`,
      data: {
        op: "save",
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        stylesheet_contents: stylesheet,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  upload(
    media: StylesheetImage,
    name: string,
    signal?: AbortSignal,
  ): Promise<RawData> {
    return this.uploadImage(
      media,
      { name: requiredString(name, "image name"), upload_type: "img" },
      signal,
    );
  }

  uploadHeader(media: StylesheetImage, signal?: AbortSignal): Promise<RawData> {
    return this.uploadImage(media, { upload_type: "header" }, signal);
  }

  uploadMobileHeader(
    media: StylesheetImage,
    signal?: AbortSignal,
  ): Promise<RawData> {
    return this.uploadImage(media, { upload_type: "banner" }, signal);
  }

  uploadMobileIcon(
    media: StylesheetImage,
    signal?: AbortSignal,
  ): Promise<RawData> {
    return this.uploadImage(media, { upload_type: "icon" }, signal);
  }

  uploadBanner(media: StylesheetAsset, signal?: AbortSignal): Promise<void> {
    return this.uploadAsset(media, "bannerBackgroundImage", {}, signal);
  }

  uploadBannerAdditionalImage(
    media: StylesheetAsset,
    options: {
      readonly align?: BannerAlignment;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    return this.uploadAsset(
      media,
      "bannerPositionedImage",
      options.align === undefined
        ? {}
        : { bannerPositionedImagePosition: options.align },
      options.signal,
    );
  }

  uploadBannerHoverImage(
    media: StylesheetAsset,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.uploadAsset(
      media,
      "secondaryBannerPositionedImage",
      {},
      signal,
    );
  }

  uploadMobileBanner(
    media: StylesheetAsset,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.uploadAsset(media, "mobileBannerImage", {}, signal);
  }

  deleteImage(name: string, signal?: AbortSignal): Promise<void> {
    return this.postDelete(
      `/r/${subredditPath(this.#subreddit)}/api/delete_sr_img`,
      { img_name: requiredString(name, "image name") },
      signal,
    );
  }

  deleteHeader(signal?: AbortSignal): Promise<void> {
    return this.postDelete(
      `/r/${subredditPath(this.#subreddit)}/api/delete_sr_header`,
      undefined,
      signal,
    );
  }

  deleteMobileHeader(signal?: AbortSignal): Promise<void> {
    return this.deleteHeader(signal);
  }

  deleteMobileIcon(signal?: AbortSignal): Promise<void> {
    return this.postDelete(
      `/r/${subredditPath(this.#subreddit)}/api/delete_sr_icon`,
      undefined,
      signal,
    );
  }

  deleteBanner(signal?: AbortSignal): Promise<void> {
    return this.updateStructured({ bannerBackgroundImage: "" }, signal);
  }

  deleteBannerAdditionalImage(signal?: AbortSignal): Promise<void> {
    return this.updateStructured(
      { bannerPositionedImage: "", secondaryBannerPositionedImage: "" },
      signal,
    );
  }

  deleteBannerHoverImage(signal?: AbortSignal): Promise<void> {
    return this.updateStructured(
      { secondaryBannerPositionedImage: "" },
      signal,
    );
  }

  deleteMobileBanner(signal?: AbortSignal): Promise<void> {
    return this.updateStructured({ mobileBannerImage: "" }, signal);
  }

  private async uploadImage(
    media: StylesheetImage,
    data: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<RawData> {
    assertModeratorAccess(this.#client, "stylesheet image upload");
    if (!(media instanceof StylesheetImage)) {
      throw new TypeError("media must be a StylesheetImage instance");
    }
    signal?.throwIfAborted();
    const body = replayableMultipart(
      [["img_type", imageType(media)], ...Object.entries(data)],
      {
        bytes: media.create(),
        contentType: media.mimeType,
        name: media.name,
      },
    );
    return imageResponse(
      await this.#client.request({
        data: body,
        method: "POST",
        path: `/r/${subredditPath(this.#subreddit)}/api/upload_sr_img`,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  }

  private async uploadAsset(
    media: StylesheetAsset,
    imageTypeName: string,
    additionalStyles: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "stylesheet asset upload");
    if (!(media instanceof StylesheetAsset)) {
      throw new TypeError("media must be a StylesheetAsset instance");
    }
    signal?.throwIfAborted();
    const lease = parseLease(
      await this.#client.request({
        method: "POST",
        path: `/api/v1/style_asset_upload_s3/${subredditPath(this.#subreddit)}`,
        data: {
          filepath: media.name,
          imagetype: imageTypeName,
          mimetype: media.mimeType,
        },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    const key = lease.fields.find(([name]) => name === "key")?.[1];
    if (key === undefined) {
      throw new TypeError("stylesheet asset lease response is missing key");
    }
    const body = replayableMultipart(lease.fields, {
      bytes: media.create(),
      contentType: media.mimeType,
      name: media.name,
    });
    signal?.throwIfAborted();
    try {
      await this.#client.request({
        auth: false,
        data: body,
        method: "POST",
        path: lease.url,
        rawJson: false,
        responseType: "text",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      uploadFailure(error);
    }
    await this.updateStructured(
      {
        [imageTypeName]: `${lease.url.replace(/\/$/, "")}/${key}`,
        ...additionalStyles,
      },
      signal,
    );
  }

  private async updateStructured(
    data: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "stylesheet structured style update");
    signal?.throwIfAborted();
    await this.#client.request({
      data,
      method: "PATCH",
      path: `/api/v1/structured_styles/${subredditPath(this.#subreddit)}`,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private async postDelete(
    path: string,
    data: Readonly<Record<string, string>> | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "stylesheet image delete");
    signal?.throwIfAborted();
    await this.#client.request({
      method: "POST",
      path,
      ...(data === undefined ? {} : { data }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
