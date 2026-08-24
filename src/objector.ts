import {
  isRawData,
  type RawData,
  type RedditClientLike,
} from "./models/base.js";
import {
  createEntityContext,
  objectifyComment,
  objectifyMoreComments,
  objectifyRedditor,
  objectifySubmission,
  objectifySubreddit,
  type EntityContext,
} from "./models/entities.js";
import { objectifyMessage } from "./models/messages.js";
import { RedditApiError, type RedditError } from "./exceptions.js";
import { LiveContributor, LiveThread } from "./models/live.js";
import {
  parseMultireddit,
  type MultiredditClient,
} from "./models/multireddit.js";

export type ModelParser = (
  client: RedditClientLike,
  data: RawData,
  context?: EntityContext,
) => unknown;

const DEFAULT_PARSERS: Readonly<Record<string, ModelParser>> = {
  LabeledMulti: (client, data) =>
    parseMultireddit(client as MultiredditClient, data),
  LiveContributor: (client, data) => new LiveContributor(client, data),
  LiveThread: (client, data) => new LiveThread(client, data),
  more: (client, data, context) => objectifyMoreComments(client, data, context),
  t1: (client, data, context) => objectifyComment(client, data, context),
  t2: (client, data, context) => objectifyRedditor(client, data, context),
  t3: (client, data, context) => objectifySubmission(client, data, context),
  t4: (client, data) => objectifyMessage(client, data),
  t5: (client, data, context) => objectifySubreddit(client, data, context),
};

function shapeKind(data: RawData): string | undefined {
  if (
    Array.isArray(data["children"]) &&
    typeof data["count"] === "number" &&
    typeof data["parent_id"] === "string"
  ) {
    return "more";
  }
  if (typeof data["parent_id"] === "string" && typeof data["id"] === "string")
    return "t1";
  if (typeof data["display_name"] === "string") return "t5";
  if (typeof data["title"] === "string" && typeof data["id"] === "string")
    return "t3";
  if (typeof data["subject"] === "string" && typeof data["id"] === "string")
    return "t4";
  if (
    typeof data["name"] === "string" &&
    (typeof data["comment_karma"] === "number" ||
      typeof data["link_karma"] === "number")
  ) {
    return "t2";
  }
  return undefined;
}

export class Objector {
  readonly client: RedditClientLike;
  readonly parsers: Readonly<Record<string, ModelParser>>;

  constructor(
    client: RedditClientLike,
    parsers: Readonly<Record<string, ModelParser>> = {},
  ) {
    this.client = client;
    this.parsers = { ...DEFAULT_PARSERS, ...parsers };
  }

  objectify(value: unknown): unknown {
    return this.objectifyWithContext(value, createEntityContext());
  }

  private objectifyWithContext(
    value: unknown,
    context: EntityContext,
  ): unknown {
    if (Array.isArray(value))
      return value.map((item) => this.objectifyWithContext(item, context));
    if (!isRawData(value)) return value;

    const json = value["json"];
    if (isRawData(json) && Array.isArray(json["errors"])) {
      const errors = json["errors"];
      if (errors.length > 0)
        throw new RedditApiError(errors as readonly RedditError[]);
    }

    if (typeof value["kind"] === "string" && "data" in value) {
      if (value["kind"] === "Listing" && isRawData(value["data"]))
        return this.objectifyListing(value["data"], context);
      const parser = this.parsers[value["kind"]];
      if (parser !== undefined && isRawData(value["data"]))
        return parser(this.client, value["data"], context);
    }

    const kind = shapeKind(value);
    if (kind !== undefined)
      return this.parsers[kind]?.(this.client, value, context) ?? value;

    const result: RawData = {};
    for (const [key, item] of Object.entries(value))
      result[key] = this.objectifyWithContext(item, context);
    return result;
  }

  private objectifyListing(data: RawData, context: EntityContext): RawData {
    const result = { ...data };
    if (Array.isArray(data["children"])) {
      result["children"] = data["children"].map((child) =>
        this.objectifyWithContext(child, context),
      );
    }
    return result;
  }
}
