import type { JsonValue, ReplayableBody } from "../core/transport.js";

export type RawData = Record<string, unknown>;

export type QueryValue = boolean | number | string | null | undefined;
export type DataValue =
  boolean | number | string | readonly (boolean | number | string)[];

export interface RedditRequest {
  readonly auth?: boolean;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: string;
  readonly rawJson?: boolean;
  readonly responseType?: "json" | "text";
  readonly params?: Readonly<Record<string, DataValue>>;
  readonly data?: Readonly<Record<string, DataValue>> | ReplayableBody;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: JsonValue;
  readonly signal?: AbortSignal;
}

export interface RedditQueryRequest {
  readonly auth?: boolean;
  readonly method: "GET";
  readonly path: string;
  readonly rawJson?: boolean;
  readonly responseType?: "json" | "text";
  readonly params?: Readonly<Record<string, QueryValue>>;
  readonly signal?: AbortSignal;
}

export interface RedditClientLike {
  request(request: RedditRequest | RedditQueryRequest): Promise<unknown>;
  post?(
    path: string,
    options?: {
      readonly data?: Readonly<Record<string, DataValue>> | ReplayableBody;
      readonly json?: JsonValue;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown>;
}

export function postRequest(
  client: RedditClientLike,
  path: string,
  data: Readonly<Record<string, DataValue>>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (client.post !== undefined) {
    return client.post(path, {
      data,
      ...(signal === undefined ? {} : { signal }),
    });
  }
  return client.request({
    method: "POST",
    path,
    data,
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface LoadOptions {
  readonly signal?: AbortSignal;
}

const RESERVED_FIELDS = new Set([
  "client",
  "clearVote",
  "comments",
  "delete",
  "downvote",
  "edit",
  "equals",
  "get",
  "hide",
  "identity",
  "isLoaded",
  "load",
  "message",
  "raw",
  "refresh",
  "reply",
  "report",
  "save",
  "submit",
  "subscribe",
  "toString",
  "unhide",
  "unsave",
  "unsubscribe",
  "upvote",
  "vote",
]);

export function isRawData(value: unknown): value is RawData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base for response-backed values whose fields are not stable API contracts. */
export class BaseModel {
  readonly client: RedditClientLike;
  #raw: RawData = {};

  constructor(client: RedditClientLike, data: RawData = {}) {
    this.client = client;
    this.applyData(data);
  }

  get raw(): Readonly<RawData> {
    return { ...this.#raw };
  }

  get<T = unknown>(field: string): T | undefined {
    return this.#raw[field] as T | undefined;
  }

  protected applyData(data: RawData): void {
    this.#raw = { ...this.#raw, ...data };
    for (const [field, value] of Object.entries(data)) {
      if (
        field.startsWith("#") ||
        field.startsWith("_") ||
        RESERVED_FIELDS.has(field)
      ) {
        continue;
      }
      Object.defineProperty(this, field, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    }
  }
}

function findData(
  value: unknown,
  identityFields: readonly string[],
  identity: string,
): RawData | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findData(item, identityFields, identity);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRawData(value)) return undefined;

  if ("kind" in value && isRawData(value["data"])) {
    const found = findData(value["data"], identityFields, identity);
    if (found !== undefined) return found;
  }
  for (const field of identityFields) {
    const candidate = value[field];
    if (
      typeof candidate === "string" &&
      candidate.toLowerCase() === identity.toLowerCase()
    ) {
      return value;
    }
  }
  if (Array.isArray(value["children"])) {
    return findData(value["children"], identityFields, identity);
  }
  if (isRawData(value["data"])) {
    return findData(value["data"], identityFields, identity);
  }
  return undefined;
}

/** Base for Reddit things with stable identity and explicit network hydration. */
export abstract class RedditModel extends BaseModel {
  abstract readonly kind: string;
  abstract readonly identityField: string;
  #loaded: boolean;

  constructor(
    client: RedditClientLike,
    identityField: string,
    value: string | RawData,
  ) {
    const data = typeof value === "string" ? { [identityField]: value } : value;
    super(client, data);
    this.#loaded = typeof value !== "string";
  }

  get identity(): string {
    const value = this.get(this.identityField);
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(
        `${this.constructor.name} has no valid ${this.identityField}`,
      );
    }
    return `${this.kind}:${value.toLowerCase()}`;
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  equals(other: unknown): boolean {
    if (typeof other === "string")
      return this.toString().toLowerCase() === other.toLowerCase();
    return (
      other instanceof RedditModel &&
      this.constructor === other.constructor &&
      this.identity === other.identity
    );
  }

  async load(options: LoadOptions = {}): Promise<this> {
    if (!this.#loaded) await this.refresh(options);
    return this;
  }

  async refresh(options: LoadOptions = {}): Promise<this> {
    options.signal?.throwIfAborted();
    const response = await this.client.request({
      method: "GET",
      ...this.fetchRequest(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const data = findData(
      response,
      this.responseIdentityFields,
      this.toString(),
    );
    if (data === undefined)
      throw new TypeError(
        `Reddit response did not contain ${this.constructor.name} data`,
      );
    this.applyLoadedData(data);
    return this;
  }

  protected applyLoadedData(data: RawData): void {
    this.applyData(data);
    this.#loaded = true;
  }

  override toString(): string {
    const value = this.get(this.identityField);
    if (typeof value !== "string")
      throw new TypeError(`${this.constructor.name} has no valid identity`);
    return value;
  }

  protected get responseIdentityFields(): readonly string[] {
    return [this.identityField, "name"];
  }

  protected abstract fetchRequest(): Pick<RedditRequest, "params" | "path">;
}

export { BaseModel as PrawBase, RedditModel as RedditBase };
