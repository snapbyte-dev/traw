import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import { replayableMultipart } from "../core/transport.js";
import {
  ResponseError,
  ServerError,
  MediaTooLargeError,
} from "../exceptions.js";
import { isRawData, type RedditClientLike } from "./base.js";

export interface MediaOptions {
  readonly maxSize?: number;
  readonly name?: string;
}

export interface PostMediaUploadOptions {
  readonly expectedMimePrefix?: "image" | "video";
  readonly signal?: AbortSignal;
  readonly uploadType?: "gallery" | "link" | "selfpost";
}

export interface InlineMediaOptions {
  readonly caption?: string;
  readonly media: PostMedia;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function validateMaxSize(maxSize: number | undefined): void {
  if (
    maxSize !== undefined &&
    (!Number.isSafeInteger(maxSize) || maxSize < 0)
  ) {
    throw new RangeError("maxSize must be a non-negative safe integer");
  }
}

/** An immutable media snapshot that can be replayed safely after a retry. */
export class Media {
  readonly name: string;
  readonly size: number;
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(source: string, options?: MediaOptions);
  constructor(
    source: Uint8Array,
    name: string,
    options?: Omit<MediaOptions, "name">,
  );
  constructor(
    source: Uint8Array,
    options: MediaOptions & { readonly name: string },
  );
  constructor(
    source: string | Uint8Array,
    nameOrOptions: string | MediaOptions = {},
    sizeOptions: Omit<MediaOptions, "name"> = {},
  ) {
    const options =
      typeof nameOrOptions === "string"
        ? { ...sizeOptions, name: nameOrOptions }
        : nameOrOptions;
    validateMaxSize(options.maxSize);
    if (typeof source !== "string" && !options.name) {
      throw new TypeError(
        "name is required when media is constructed from bytes",
      );
    }

    const bytes =
      typeof source === "string"
        ? new Uint8Array(readFileSync(source))
        : new Uint8Array(source);
    if (options.maxSize !== undefined && bytes.byteLength > options.maxSize) {
      throw new RangeError(
        `media size ${bytes.byteLength} exceeds maximum ${options.maxSize}`,
      );
    }

    this.name = options.name ?? basename(source as string);
    this.size = bytes.byteLength;
    this.#bytes = new Uint8Array(bytes.buffer.slice(0));
  }

  get mimeType(): string {
    const type = MIME_TYPES[extname(this.name).toLowerCase()];
    if (type === undefined) {
      throw new TypeError(`Unable to determine the MIME type of ${this.name}`);
    }
    return type;
  }

  get contentType(): string {
    return this.mimeType;
  }

  create(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.#bytes.buffer.slice(0));
  }

  validateSize(maxSize: number): this {
    validateMaxSize(maxSize);
    if (this.size > maxSize) {
      throw new RangeError(
        `media size ${this.size} exceeds maximum ${maxSize}`,
      );
    }
    return this;
  }

  static fromBytes(
    bytes: Uint8Array,
    name: string,
    options: Omit<MediaOptions, "name"> = {},
  ): Media {
    return new this(bytes, name, options);
  }

  static fromPath(path: string, options: MediaOptions = {}): Media {
    return new this(path, options);
  }
}

export class EmojiMedia extends Media {}
export class StylesheetAsset extends Media {}
export class StylesheetImage extends Media {}

interface UploadLease {
  readonly assetId: string;
  readonly fields: readonly (readonly [string, string])[];
  readonly url: string;
}

function parseLease(value: unknown): UploadLease {
  if (!isRawData(value) || !isRawData(value["args"]))
    throw new TypeError("media lease response is missing args");
  const args = value["args"];
  const action = args["action"];
  const rawFields = args["fields"];
  const asset = value["asset"];
  if (
    typeof action !== "string" ||
    !Array.isArray(rawFields) ||
    !isRawData(asset) ||
    typeof asset["asset_id"] !== "string"
  )
    throw new TypeError("media lease response is malformed");
  const fields = rawFields.map((field): readonly [string, string] => {
    if (
      !isRawData(field) ||
      typeof field["name"] !== "string" ||
      typeof field["value"] !== "string"
    )
      throw new TypeError("media lease response contains a malformed field");
    return [field["name"], field["value"]];
  });
  return {
    assetId: asset["asset_id"],
    fields,
    url: action.startsWith("//") ? `https:${action}` : action,
  };
}

function uploadError(error: unknown): never {
  if (!(error instanceof ResponseError)) throw error;
  const body =
    typeof error.response.body === "string"
      ? error.response.body
      : (error.response.text?.() ?? "");
  const actual = /<ProposedSize>(\d+)<\/ProposedSize>/.exec(body)?.[1];
  const maximum = /<MaxSizeAllowed>(\d+)<\/MaxSizeAllowed>/.exec(body)?.[1];
  if (actual !== undefined && maximum !== undefined) {
    throw new MediaTooLargeError({
      actual: Number(actual),
      maximumSize: Number(maximum),
    });
  }
  throw new ServerError(error.response);
}

export class PostMedia extends Media {
  static override fromBytes(
    bytes: Uint8Array,
    name: string,
    options: Omit<MediaOptions, "name"> = {},
  ): PostMedia {
    return new this(bytes, name, options);
  }

  static override fromPath(
    path: string,
    options: MediaOptions = {},
  ): PostMedia {
    return new this(path, options);
  }

  async upload(
    client: RedditClientLike,
    options: PostMediaUploadOptions = {},
  ): Promise<string> {
    const majorType = this.mimeType.split("/", 1)[0];
    if (
      options.expectedMimePrefix !== undefined &&
      majorType !== options.expectedMimePrefix
    ) {
      throw new TypeError(
        `Expected a MIME type starting with ${options.expectedMimePrefix} but got ${this.mimeType} from ${this.name}`,
      );
    }
    options.signal?.throwIfAborted();
    const lease = parseLease(
      await client.request({
        data: { filepath: this.name, mimetype: this.mimeType },
        method: "POST",
        path: "/api/media/asset.json",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
    const body = replayableMultipart(lease.fields, {
      bytes: this.create(),
      contentType: this.mimeType,
      name: this.name,
    });
    try {
      await client.request({
        auth: false,
        data: body,
        method: "POST",
        path: lease.url,
        rawJson: false,
        responseType: "text",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      uploadError(error);
    }
    if ((options.uploadType ?? "link") !== "link") return lease.assetId;
    const key = lease.fields.find(([name]) => name === "key")?.[1];
    if (key === undefined)
      throw new TypeError("media lease response is missing key");
    return `${lease.url.replace(/\/$/, "")}/${key}`;
  }
}

export type InlineMediaType = "gif" | "img" | "video";

/** Media uploaded with a self-post lease and rendered as Reddit media Markdown. */
export abstract class InlineMedia {
  abstract readonly type: InlineMediaType;
  readonly caption: string | undefined;
  readonly media: PostMedia;
  mediaId: string | null = null;

  constructor(options: InlineMediaOptions) {
    if (!(options.media instanceof PostMedia))
      throw new TypeError("media must be a PostMedia instance");
    this.caption = options.caption;
    this.media = options.media;
  }

  toString(): string {
    return `\n\n![${this.type}](${this.mediaId ?? ""} "${this.caption ?? ""}")\n\n`;
  }
}

export class InlineGif extends InlineMedia {
  readonly type = "gif";

  constructor(options: InlineMediaOptions) {
    super(options);
    if (this.media.mimeType !== "image/gif")
      throw new TypeError("InlineGif media must have an image/gif MIME type");
  }
}

export class InlineImage extends InlineMedia {
  readonly type = "img";

  constructor(options: InlineMediaOptions) {
    super(options);
    if (
      !this.media.mimeType.startsWith("image/") ||
      this.media.mimeType === "image/gif"
    )
      throw new TypeError(
        "InlineImage media must have a non-GIF image MIME type",
      );
  }
}

export class InlineVideo extends InlineMedia {
  readonly type = "video";

  constructor(options: InlineMediaOptions) {
    super(options);
    if (!this.media.mimeType.startsWith("video/"))
      throw new TypeError("InlineVideo media must have a video MIME type");
  }
}
