import { ReadOnlyException } from "../exceptions.js";
import {
  BaseModel,
  isRawData,
  type RawData,
  type RedditClientLike,
} from "./base.js";
import { Subreddit } from "./entities.js";
import { registerModelParsers } from "../objector.js";

export interface ModerationClientLike extends RedditClientLike {
  readonly readOnly?: boolean;
}

export type SubredditReference = string | Subreddit;
export type RedditorReference = string | { readonly toString: () => string };
export type ThingReference = string | { readonly fullname: string };

export function assertModeratorAccess(
  client: ModerationClientLike,
  operation: string,
): void {
  if (client.readOnly === true) {
    throw new ReadOnlyException(`${operation} does not work in read-only mode`);
  }
}

export function requiredString(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return normalized;
}

export function referenceString(
  value: string | { readonly toString: () => string },
  name: string,
): string {
  return requiredString(String(value), name);
}

export function subredditName(value: SubredditReference): string {
  return referenceString(value, "subreddit");
}

export function subredditPath(value: SubredditReference): string {
  return encodeURIComponent(subredditName(value));
}

export function responseData(value: unknown, description: string): RawData {
  let result = value;
  if (isRawData(result) && isRawData(result["json"])) result = result["json"];
  if (isRawData(result) && isRawData(result["data"])) result = result["data"];
  if (!isRawData(result)) {
    throw new TypeError(`Reddit returned invalid ${description} data`);
  }
  return result;
}

export function responseArray(value: unknown, description: string): RawData[] {
  let result = value;
  if (isRawData(result) && Array.isArray(result["data"]))
    result = result["data"];
  if (!Array.isArray(result) || !result.every(isRawData)) {
    throw new TypeError(`Reddit returned invalid ${description} data`);
  }
  return result;
}

abstract class IdentifiedModerationModel extends BaseModel {
  abstract readonly identityField: string;

  override toString(): string {
    const value = this.get(this.identityField);
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${this.constructor.name} has no valid identity`);
    }
    return value;
  }
}

export class ModAction extends IdentifiedModerationModel {
  readonly identityField = "id";
}

export class ModNote extends IdentifiedModerationModel {
  readonly identityField = "id";
}

export class FlairTemplate extends IdentifiedModerationModel {
  readonly identityField = "id";
  readonly subreddit: SubredditReference;
  readonly isLink: boolean;

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    isLink: boolean,
    data: RawData,
  ) {
    super(client, data);
    this.subreddit = subreddit;
    this.isLink = isLink;
  }
}

export class Rule extends IdentifiedModerationModel {
  readonly identityField = "short_name";
  readonly subreddit: SubredditReference;

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    value: string | RawData,
  ) {
    super(client, typeof value === "string" ? { short_name: value } : value);
    this.subreddit = subreddit;
  }
}

export class RemovalReason extends IdentifiedModerationModel {
  readonly identityField = "id";
  readonly subreddit: SubredditReference;

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    value: string | RawData,
  ) {
    super(client, typeof value === "string" ? { id: value } : value);
    this.subreddit = subreddit;
  }
}

registerModelParsers({
  modaction: (client, data) => new ModAction(client, data),
  mod_note: (client, data) => new ModNote(client, data),
});
