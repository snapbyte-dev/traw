import { Listing, type ListingOptions } from "../listing.js";
import { streamGenerator, type StreamOptions } from "../stream.js";
import { Objector } from "../objector.js";
import {
  ModAction,
  assertModeratorAccess,
  responseData,
  subredditName,
  subredditPath,
  type ModerationClientLike,
  type SubredditReference,
} from "../models/moderation.js";
import {
  Subreddit,
  type Comment,
  type Submission,
} from "../models/entities.js";
import { SubredditModNotes } from "./mod-notes.js";

export type ModeratedItem = Comment | Submission;
export type QueueOnly = "comments" | "submissions";

export interface QueueOptions extends ListingOptions {
  readonly only?: QueueOnly;
}

export interface ModLogOptions extends ListingOptions {
  readonly action?: string;
  readonly moderator?: string | { readonly toString: () => string };
}

export interface ModerationStreamOptions<T> extends StreamOptions<T> {
  readonly listing?: Omit<ListingOptions, "limit" | "signal">;
}

export type SpamFilterStrength = "all" | "high" | "low";
export type SubredditContentOptions = "any" | "link" | "self";
export type SubredditType =
  | "archived"
  | "employees_only"
  | "gold_only"
  | "gold_restricted"
  | "private"
  | "public"
  | "restricted";
export type SuggestedCommentSort =
  | "confidence"
  | "controversial"
  | "live"
  | "new"
  | "old"
  | "qa"
  | "random"
  | "top";
export type WikiMode = "anyone" | "disabled" | "modonly";
export type SubredditSettingValue = boolean | number | string | null;
export type SubredditSettings = Readonly<Record<string, SubredditSettingValue>>;

export interface SubredditSettingsOptions {
  readonly allOriginalContent?: boolean;
  readonly allowChatPostCreation?: boolean;
  readonly allowImages?: boolean;
  readonly allowPolls?: boolean;
  readonly allowPostCrossposts?: boolean;
  readonly allowVideos?: boolean;
  readonly collapseDeletedComments?: boolean;
  readonly commentScoreHideMins?: number;
  readonly contentOptions?: SubredditContentOptions;
  readonly crowdControlChatLevel?: 0 | 1 | 2 | 3;
  readonly crowdControlLevel?: 0 | 1 | 2 | 3;
  readonly crowdControlMode?: boolean;
  readonly defaultSet?: boolean;
  readonly description?: string;
  readonly disableContributorRequests?: boolean;
  readonly domain?: string;
  readonly excludeBannedModqueue?: boolean;
  readonly freeFormReports?: boolean;
  readonly headerHoverText?: string;
  readonly hideAds?: boolean;
  readonly keyColor?: string;
  readonly language?: string;
  readonly originalContentTagEnabled?: boolean;
  readonly over18?: boolean;
  readonly publicDescription?: string;
  readonly publicTraffic?: boolean;
  readonly restrictCommenting?: boolean;
  readonly restrictPosting?: boolean;
  readonly showMedia?: boolean;
  readonly showMediaPreview?: boolean;
  readonly spamComments?: SpamFilterStrength;
  readonly spamLinks?: SpamFilterStrength;
  readonly spamSelfposts?: SpamFilterStrength;
  readonly spoilersEnabled?: boolean;
  readonly submitLinkLabel?: string | null;
  readonly submitText?: string;
  readonly submitTextLabel?: string | null;
  readonly subredditType?: SubredditType;
  readonly suggestedCommentSort?: SuggestedCommentSort | null;
  readonly title?: string;
  readonly welcomeMessageEnabled?: boolean;
  readonly welcomeMessageText?: string;
  readonly wikiEditAge?: number;
  readonly wikiEditKarma?: number;
  readonly wikimode?: WikiMode;
}

const SETTING_NAMES: Readonly<Record<keyof SubredditSettingsOptions, string>> =
  {
    allOriginalContent: "all_original_content",
    allowChatPostCreation: "allow_chat_post_creation",
    allowImages: "allow_images",
    allowPolls: "allow_polls",
    allowPostCrossposts: "allow_post_crossposts",
    allowVideos: "allow_videos",
    collapseDeletedComments: "collapse_deleted_comments",
    commentScoreHideMins: "comment_score_hide_mins",
    contentOptions: "link_type",
    crowdControlChatLevel: "crowd_control_chat_level",
    crowdControlLevel: "crowd_control_level",
    crowdControlMode: "crowd_control_mode",
    defaultSet: "allow_top",
    description: "description",
    disableContributorRequests: "disable_contributor_requests",
    domain: "domain",
    excludeBannedModqueue: "exclude_banned_modqueue",
    freeFormReports: "free_form_reports",
    headerHoverText: "header_title",
    hideAds: "hide_ads",
    keyColor: "key_color",
    language: "lang",
    originalContentTagEnabled: "original_content_tag_enabled",
    over18: "over_18",
    publicDescription: "public_description",
    publicTraffic: "public_traffic",
    restrictCommenting: "restrict_commenting",
    restrictPosting: "restrict_posting",
    showMedia: "show_media",
    showMediaPreview: "show_media_preview",
    spamComments: "spam_comments",
    spamLinks: "spam_links",
    spamSelfposts: "spam_selfposts",
    spoilersEnabled: "spoilers_enabled",
    submitLinkLabel: "submit_link_label",
    submitText: "submit_text",
    submitTextLabel: "submit_text_label",
    subredditType: "type",
    suggestedCommentSort: "suggested_comment_sort",
    title: "title",
    welcomeMessageEnabled: "welcome_message_enabled",
    welcomeMessageText: "welcome_message_text",
    wikiEditAge: "wiki_edit_age",
    wikiEditKarma: "wiki_edit_karma",
    wikimode: "wikimode",
  };

function validateEnum(
  value: string | null | undefined,
  values: readonly string[],
  name: string,
): void {
  if (value !== undefined && value !== null && !values.includes(value)) {
    throw new RangeError(`Invalid ${name}: ${value}`);
  }
}

export function validateSubredditSettings(
  settings: SubredditSettingsOptions,
): void {
  validateEnum(
    settings.contentOptions,
    ["any", "link", "self"],
    "contentOptions",
  );
  validateEnum(
    settings.subredditType,
    [
      "archived",
      "employees_only",
      "gold_only",
      "gold_restricted",
      "private",
      "public",
      "restricted",
    ],
    "subredditType",
  );
  validateEnum(
    settings.wikimode,
    ["anyone", "disabled", "modonly"],
    "wikimode",
  );
  validateEnum(
    settings.suggestedCommentSort,
    [
      "confidence",
      "controversial",
      "live",
      "new",
      "old",
      "qa",
      "random",
      "top",
    ],
    "suggestedCommentSort",
  );
  for (const [name, value] of [
    ["spamComments", settings.spamComments],
    ["spamLinks", settings.spamLinks],
    ["spamSelfposts", settings.spamSelfposts],
  ] as const) {
    validateEnum(value, ["all", "high", "low"], name);
  }
  for (const [name, value] of [
    ["commentScoreHideMins", settings.commentScoreHideMins],
    ["wikiEditAge", settings.wikiEditAge],
    ["wikiEditKarma", settings.wikiEditKarma],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative integer`);
    }
  }
  for (const [name, value] of [
    ["crowdControlChatLevel", settings.crowdControlChatLevel],
    ["crowdControlLevel", settings.crowdControlLevel],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 0 || value > 3)
    ) {
      throw new RangeError(`${name} must be an integer from 0 through 3`);
    }
  }
  if (
    settings.keyColor !== undefined &&
    !/^#[0-9a-f]{6}$/i.test(settings.keyColor)
  ) {
    throw new TypeError("keyColor must be a 6-digit RGB hex color");
  }
}

export function subredditSettingsPayload(
  settings: SubredditSettingsOptions,
  create = false,
): Record<string, SubredditSettingValue> {
  const data: Record<string, SubredditSettingValue> = {};
  for (const [key, name] of Object.entries(SETTING_NAMES)) {
    const value = settings[key as keyof SubredditSettingsOptions];
    if (value !== undefined) {
      data[create && key === "headerHoverText" ? "header-title" : name] = value;
    }
  }
  return data;
}

export function subredditSettingsData(value: unknown): SubredditSettings {
  const data = responseData(value, "subreddit settings");
  for (const item of Object.values(data)) {
    if (
      item !== null &&
      typeof item !== "boolean" &&
      typeof item !== "number" &&
      typeof item !== "string"
    ) {
      throw new TypeError("Reddit returned invalid subreddit settings data");
    }
  }
  return data as SubredditSettings;
}

function queueParams(options: QueueOptions): ListingOptions {
  const { only, ...listing } = options;
  return {
    ...listing,
    params: {
      ...listing.params,
      ...(only === undefined
        ? {}
        : { only: only === "submissions" ? "links" : only }),
    },
  };
}

export class SubredditModerationStream {
  readonly #moderation: SubredditModeration;

  constructor(moderation: SubredditModeration) {
    this.#moderation = moderation;
  }

  edited(options: ModerationStreamOptions<ModeratedItem> = {}) {
    return this.queue((listing) => this.#moderation.edited(listing), options);
  }

  modqueue(options: ModerationStreamOptions<ModeratedItem> = {}) {
    return this.queue((listing) => this.#moderation.modqueue(listing), options);
  }

  reports(options: ModerationStreamOptions<ModeratedItem> = {}) {
    return this.queue((listing) => this.#moderation.reports(listing), options);
  }

  spam(options: ModerationStreamOptions<ModeratedItem> = {}) {
    return this.queue((listing) => this.#moderation.spam(listing), options);
  }

  unmoderated(options: ModerationStreamOptions<Submission> = {}) {
    const { listing = {}, ...stream } = options;
    return streamGenerator<Submission>(
      ({ before, limit, signal }) =>
        this.#moderation.unmoderated({
          ...listing,
          limit,
          params: {
            ...listing.params,
            ...(before === undefined ? {} : { before }),
          },
          ...(signal === undefined ? {} : { signal }),
        }),
      stream,
    );
  }

  log(options: ModerationStreamOptions<ModAction> & ModLogOptions = {}) {
    const { listing = {}, action, moderator, ...stream } = options;
    return streamGenerator<ModAction>(
      ({ before, limit, signal }) =>
        this.#moderation.log({
          ...listing,
          ...(action === undefined ? {} : { action }),
          ...(moderator === undefined ? {} : { moderator }),
          limit,
          params: {
            ...listing.params,
            ...(before === undefined ? {} : { before }),
          },
          ...(signal === undefined ? {} : { signal }),
        }),
      stream,
    );
  }

  private queue(
    fetch: (options: QueueOptions) => Listing<ModeratedItem>,
    options: ModerationStreamOptions<ModeratedItem>,
  ) {
    const { listing = {}, ...stream } = options;
    return streamGenerator<ModeratedItem>(
      ({ before, limit, signal }) =>
        fetch({
          ...listing,
          limit,
          params: {
            ...listing.params,
            ...(before === undefined ? {} : { before }),
          },
          ...(signal === undefined ? {} : { signal }),
        }),
      stream,
    );
  }
}

export class SubredditModeration {
  readonly client: ModerationClientLike;
  readonly subreddit: SubredditReference;
  readonly stream: SubredditModerationStream;
  readonly notes: SubredditModNotes;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.client = client;
    this.subreddit = subreddit;
    subredditName(subreddit);
    this.stream = new SubredditModerationStream(this);
    this.notes = new SubredditModNotes(client, subreddit);
  }

  edited(options: QueueOptions = {}): Listing<ModeratedItem> {
    return this.queue("edited", options);
  }

  modqueue(options: QueueOptions = {}): Listing<ModeratedItem> {
    return this.queue("modqueue", options);
  }

  reports(options: QueueOptions = {}): Listing<ModeratedItem> {
    return this.queue("reports", options);
  }

  spam(options: QueueOptions = {}): Listing<ModeratedItem> {
    return this.queue("spam", options);
  }

  unmoderated(options: ListingOptions = {}): Listing<Submission> {
    assertModeratorAccess(this.client, "moderation.unmoderated()");
    return new Listing(
      this.client,
      `/r/${subredditPath(this.subreddit)}/about/unmoderated/`,
      options,
    );
  }

  log(options: ModLogOptions = {}): Listing<ModAction> {
    assertModeratorAccess(this.client, "moderation.log()");
    const { action, moderator, ...listing } = options;
    return new Listing(
      this.client,
      `/r/${subredditPath(this.subreddit)}/about/log/`,
      {
        ...listing,
        objector: new Objector(this.client, {
          modaction: (client, data) => new ModAction(client, data),
        }),
        params: {
          ...listing.params,
          ...(action === undefined ? {} : { type: action }),
          ...(moderator === undefined ? {} : { mod: String(moderator) }),
        },
      },
    );
  }

  async settings(signal?: AbortSignal): Promise<SubredditSettings> {
    assertModeratorAccess(this.client, "moderation.settings()");
    signal?.throwIfAborted();
    const response = await this.client.request({
      method: "GET",
      path: `/r/${subredditPath(this.subreddit)}/about/edit/`,
      ...(signal === undefined ? {} : { signal }),
    });
    return subredditSettingsData(response);
  }

  async update(
    settings: SubredditSettingsOptions,
    signal?: AbortSignal,
  ): Promise<SubredditSettings> {
    assertModeratorAccess(this.client, "moderation.update()");
    signal?.throwIfAborted();
    validateSubredditSettings(settings);
    const name = subredditName(this.subreddit);
    const fullname =
      this.subreddit instanceof Subreddit ? this.subreddit.fullname : undefined;
    const response = await this.client.request({
      method: "PATCH",
      path: "/api/v1/subreddit/update_settings",
      json: { ...subredditSettingsPayload(settings), sr: fullname ?? name },
      ...(signal === undefined ? {} : { signal }),
    });
    return subredditSettingsData(response);
  }

  async acceptInvite(signal?: AbortSignal): Promise<void> {
    assertModeratorAccess(this.client, "moderation.acceptInvite()");
    signal?.throwIfAborted();
    await this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/api/accept_moderator_invite`,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private queue(name: string, options: QueueOptions): Listing<ModeratedItem> {
    assertModeratorAccess(this.client, `moderation.${name}()`);
    return new Listing(
      this.client,
      `/r/${subredditPath(this.subreddit)}/about/${name}/`,
      queueParams(options),
    );
  }
}

export class SubredditQuarantine {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.#client = client;
    this.#subreddit = subreddit;
    subredditName(subreddit);
  }

  optIn(signal?: AbortSignal): Promise<unknown> {
    return this.update("/api/quarantine_optin", signal);
  }

  optOut(signal?: AbortSignal): Promise<unknown> {
    return this.update("/api/quarantine_optout", signal);
  }

  private update(path: string, signal?: AbortSignal): Promise<unknown> {
    assertModeratorAccess(this.#client, "quarantine update");
    signal?.throwIfAborted();
    return this.#client.request({
      method: "POST",
      path,
      data: { sr_name: subredditName(this.#subreddit) },
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export function createSubredditModeration(
  client: ModerationClientLike,
  subreddit: SubredditReference,
): SubredditModeration {
  return new SubredditModeration(client, subreddit);
}
