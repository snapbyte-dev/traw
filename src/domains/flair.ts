import { InvalidFlairTemplateIdError } from "../exceptions.js";
import type { DataValue } from "../models/base.js";
import {
  FlairTemplate,
  assertModeratorAccess,
  referenceString,
  responseArray,
  requiredString,
  subredditPath,
  type ModerationClientLike,
  type RedditorReference,
  type SubredditReference,
  type ThingReference,
} from "../models/moderation.js";

export interface FlairSetOptions {
  readonly cssClass?: string;
  readonly templateId?: string;
  readonly text?: string;
}

export interface FlairConfigureOptions {
  readonly enabled?: boolean;
  readonly linkPosition?: "left" | "right";
  readonly linkSelfAssign?: boolean;
  readonly position?: "left" | "right";
  readonly selfAssign?: boolean;
}

export interface FlairTemplateOptions {
  readonly allowableContent?: "all" | "emoji" | "text";
  readonly backgroundColor?: string;
  readonly cssClass?: string;
  readonly maxEmojis?: number;
  readonly modOnly?: boolean;
  readonly textColor?: "dark" | "light";
  readonly textEditable?: boolean;
}

export interface FlairTemplateUpdateOptions extends FlairTemplateOptions {
  readonly fetch?: boolean;
  readonly text?: string;
}

function templateData(
  text: string | undefined,
  options: FlairTemplateOptions,
): Record<string, DataValue> {
  if (
    options.maxEmojis !== undefined &&
    (!Number.isInteger(options.maxEmojis) || options.maxEmojis < 0)
  ) {
    throw new RangeError("maxEmojis must be a non-negative integer");
  }
  const data: Record<string, DataValue> = {};
  if (text !== undefined) data["text"] = text;
  if (options.allowableContent !== undefined)
    data["allowable_content"] = options.allowableContent;
  if (options.backgroundColor !== undefined)
    data["background_color"] = options.backgroundColor;
  if (options.cssClass !== undefined) data["css_class"] = options.cssClass;
  if (options.maxEmojis !== undefined) data["max_emojis"] = options.maxEmojis;
  if (options.modOnly !== undefined) data["mod_only"] = options.modOnly;
  if (options.textColor !== undefined) data["text_color"] = options.textColor;
  if (options.textEditable !== undefined)
    data["text_editable"] = options.textEditable;
  return data;
}

function rawString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export class FlairTemplates {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;
  readonly #isLink: boolean;

  constructor(
    client: ModerationClientLike,
    subreddit: SubredditReference,
    isLink: boolean,
  ) {
    this.#client = client;
    this.#subreddit = subreddit;
    this.#isLink = isLink;
    subredditPath(subreddit);
  }

  async list(signal?: AbortSignal): Promise<FlairTemplate[]> {
    assertModeratorAccess(this.#client, "flair.templates.list()");
    const response = await this.#client.request({
      method: "GET",
      path: `/r/${subredditPath(this.#subreddit)}/api/${this.#isLink ? "link" : "user"}_flair_v2`,
      ...(signal === undefined ? {} : { signal }),
    });
    return responseArray(response, "flair templates").map(
      (data) =>
        new FlairTemplate(this.#client, this.#subreddit, this.#isLink, data),
    );
  }

  async add(
    text: string,
    options: FlairTemplateOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "flair.templates.add()");
    templateData(text, options);
    await this.#client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#subreddit)}/api/flairtemplate_v2`,
      data: {
        allowable_content: options.allowableContent ?? "all",
        background_color: options.backgroundColor ?? "",
        css_class: options.cssClass ?? "",
        flair_type: this.#isLink ? "LINK_FLAIR" : "USER_FLAIR",
        max_emojis: options.maxEmojis ?? 10,
        mod_only: options.modOnly ?? false,
        text: requiredString(text, "flair text"),
        text_color: options.textColor ?? "dark",
        text_editable: options.textEditable ?? false,
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async update(
    templateId: string,
    options: FlairTemplateUpdateOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "flair.templates.update()");
    const id = requiredString(templateId, "template ID");
    const { fetch = true, text, ...templateOptions } = options;
    let data = templateData(text, templateOptions);
    if (fetch) {
      const existing = (await this.list(signal)).find(
        (item) => String(item) === id,
      );
      if (existing === undefined) throw new InvalidFlairTemplateIdError(id);
      const raw = existing.raw;
      data = {
        allowable_content: rawString(raw["allowable_content"], "all"),
        background_color: rawString(raw["background_color"], ""),
        css_class: rawString(raw["css_class"], ""),
        max_emojis:
          typeof raw["max_emojis"] === "number" ? raw["max_emojis"] : 10,
        mod_only: raw["mod_only"] === true,
        text: rawString(raw["flair_text"], rawString(raw["text"], "")),
        text_color: rawString(raw["text_color"], "dark"),
        text_editable: raw["text_editable"] === true,
        ...data,
      };
    }
    await this.#client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#subreddit)}/api/flairtemplate_v2`,
      data: { ...data, flair_template_id: id },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async delete(templateId: string, signal?: AbortSignal): Promise<void> {
    assertModeratorAccess(this.#client, "flair.templates.delete()");
    await this.#client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#subreddit)}/api/deleteflairtemplate/`,
      data: { flair_template_id: requiredString(templateId, "template ID") },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async clear(signal?: AbortSignal): Promise<void> {
    assertModeratorAccess(this.#client, "flair.templates.clear()");
    await this.#client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#subreddit)}/api/clearflairtemplates/`,
      data: { flair_type: this.#isLink ? "LINK_FLAIR" : "USER_FLAIR" },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async reorder(
    templates: readonly (string | FlairTemplate)[],
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "flair.templates.reorder()");
    const ids = templates.map((template) =>
      requiredString(String(template), "template ID"),
    );
    await this.#client.request({
      method: "PATCH",
      path: `/r/${subredditPath(this.#subreddit)}/api/flair_template_order`,
      params: {
        flair_type: this.#isLink ? "LINK_FLAIR" : "USER_FLAIR",
        subreddit: String(this.#subreddit),
      },
      json: ids,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export class SubredditFlair {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;
  readonly templates: FlairTemplates;
  readonly linkTemplates: FlairTemplates;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.#client = client;
    this.#subreddit = subreddit;
    this.templates = new FlairTemplates(client, subreddit, false);
    this.linkTemplates = new FlairTemplates(client, subreddit, true);
  }

  async configure(
    options: FlairConfigureOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "flair.configure()");
    const data: Record<string, DataValue> = {};
    if (options.enabled !== undefined) data["flair_enabled"] = options.enabled;
    if (options.linkPosition !== undefined)
      data["link_flair_position"] = options.linkPosition;
    if (options.linkSelfAssign !== undefined)
      data["link_flair_self_assign_enabled"] = options.linkSelfAssign;
    if (options.position !== undefined)
      data["flair_position"] = options.position;
    if (options.selfAssign !== undefined)
      data["flair_self_assign_enabled"] = options.selfAssign;
    await this.#client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#subreddit)}/api/flairconfig/`,
      data,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  setUser(
    redditor: RedditorReference,
    options: FlairSetOptions = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.set(
      referenceString(redditor, "redditor"),
      "name",
      options,
      signal,
    );
  }

  setLink(
    thing: ThingReference,
    options: FlairSetOptions = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const fullname = typeof thing === "string" ? thing : thing.fullname;
    return this.set(
      requiredString(fullname, "thing fullname"),
      "link",
      options,
      signal,
    );
  }

  deleteUser(
    redditor: RedditorReference,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertModeratorAccess(this.#client, "flair.deleteUser()");
    return this.#client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#subreddit)}/api/deleteflair`,
      data: { name: referenceString(redditor, "redditor") },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private set(
    value: string,
    field: "link" | "name",
    options: FlairSetOptions,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertModeratorAccess(this.#client, "flair.set()");
    if (options.cssClass !== undefined && options.templateId !== undefined) {
      throw new TypeError("cssClass cannot be used with templateId");
    }
    const data: Record<string, DataValue> = {
      [field]: value,
      text: options.text ?? "",
    };
    if (options.templateId !== undefined)
      data["flair_template_id"] = requiredString(
        options.templateId,
        "template ID",
      );
    else data["css_class"] = options.cssClass ?? "";
    return this.#client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#subreddit)}/api/${options.templateId === undefined ? "flair/" : "selectflair/"}`,
      data,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
