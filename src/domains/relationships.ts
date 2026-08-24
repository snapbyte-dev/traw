import { Listing, type ListingOptions } from "../listing.js";
import { Redditor, Subreddit } from "../models/entities.js";
import {
  assertModeratorAccess,
  referenceString,
  subredditName,
  subredditPath,
  type ModerationClientLike,
  type RedditorReference,
  type SubredditReference,
} from "../models/moderation.js";

export type RelationshipType =
  "banned" | "contributor" | "muted" | "wikibanned" | "wikicontributor";

export type ModeratorPermission =
  | "access"
  | "all"
  | "chat_config"
  | "chat_operator"
  | "config"
  | "flair"
  | "mail"
  | "posts"
  | "users"
  | "wiki";

export interface RelationshipListOptions extends ListingOptions {
  readonly redditor?: RedditorReference;
}

export interface BanOptions {
  readonly banContext?: string;
  readonly banMessage?: string;
  readonly banReason?: string;
  readonly duration?: number;
  readonly note?: string;
}

export interface MuteOptions {
  readonly note?: string;
}

const LIST_NAMES: Readonly<Record<RelationshipType, string>> = {
  banned: "banned",
  contributor: "contributors",
  muted: "muted",
  wikibanned: "wikibanned",
  wikicontributor: "wikicontributors",
};

function settingsData(options: BanOptions): Record<string, number | string> {
  const data: Record<string, number | string> = {};
  if (options.banContext !== undefined)
    data["ban_context"] = options.banContext;
  if (options.banMessage !== undefined)
    data["ban_message"] = options.banMessage;
  if (options.banReason !== undefined) data["ban_reason"] = options.banReason;
  if (options.duration !== undefined) {
    if (
      !Number.isInteger(options.duration) ||
      options.duration < 1 ||
      options.duration > 999
    ) {
      throw new RangeError("duration must be an integer from 1 through 999");
    }
    data["duration"] = options.duration;
  }
  if (options.note !== undefined) data["note"] = options.note;
  return data;
}

export class SubredditRelationship {
  readonly client: ModerationClientLike;
  readonly subreddit: SubredditReference;
  readonly type: RelationshipType;

  constructor(
    client: ModerationClientLike,
    subreddit: SubredditReference,
    type: RelationshipType,
  ) {
    this.client = client;
    this.subreddit = subreddit;
    this.type = type;
    subredditName(subreddit);
  }

  list(options: RelationshipListOptions = {}): Listing<Redditor> {
    assertModeratorAccess(this.client, `${this.type}.list()`);
    const { redditor, ...listing } = options;
    return new Listing(
      this.client,
      `/r/${subredditPath(this.subreddit)}/about/${LIST_NAMES[this.type]}/`,
      {
        ...listing,
        params: {
          ...listing.params,
          ...(redditor === undefined
            ? {}
            : { user: referenceString(redditor, "redditor") }),
        },
      },
    );
  }

  add(
    redditor: RedditorReference,
    options: BanOptions = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertModeratorAccess(this.client, `${this.type}.add()`);
    return this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/api/friend/`,
      data: {
        name: referenceString(redditor, "redditor"),
        type: this.type,
        ...settingsData(options),
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  remove(redditor: RedditorReference, signal?: AbortSignal): Promise<unknown> {
    assertModeratorAccess(this.client, `${this.type}.remove()`);
    return this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/api/unfriend/`,
      data: {
        name: referenceString(redditor, "redditor"),
        type: this.type,
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export class ContributorRelationship extends SubredditRelationship {
  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    super(client, subreddit, "contributor");
  }

  leave(signal?: AbortSignal): Promise<unknown> {
    assertModeratorAccess(this.client, "contributor.leave()");
    const fullname =
      this.subreddit instanceof Subreddit ? this.subreddit.fullname : undefined;
    if (fullname === undefined) {
      throw new TypeError(
        "A loaded Subreddit with a fullname is required to leave",
      );
    }
    return this.client.request({
      method: "POST",
      path: "/api/leavecontributor",
      data: { id: fullname },
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export class ModeratorRelationship {
  readonly client: ModerationClientLike;
  readonly subreddit: SubredditReference;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.client = client;
    this.subreddit = subreddit;
    subredditName(subreddit);
  }

  list(options: RelationshipListOptions = {}): Listing<Redditor> {
    assertModeratorAccess(this.client, "moderator.list()");
    const { redditor, ...listing } = options;
    return new Listing(
      this.client,
      `/r/${subredditPath(this.subreddit)}/about/moderators/`,
      {
        ...listing,
        params: {
          ...listing.params,
          ...(redditor === undefined ? {} : { user: String(redditor) }),
        },
      },
    );
  }

  invited(options: ListingOptions = {}): Listing<Redditor> {
    assertModeratorAccess(this.client, "moderator.invited()");
    return new Listing(
      this.client,
      `/api/v1/${subredditPath(this.subreddit)}/moderators_invited`,
      options,
    );
  }

  add(
    redditor: RedditorReference,
    permissions: readonly ModeratorPermission[] = ["all"],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.friend(redditor, permissions, "moderator", signal);
  }

  invite(
    redditor: RedditorReference,
    permissions: readonly ModeratorPermission[] = ["all"],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.friend(redditor, permissions, "moderator_invite", signal);
  }

  update(
    redditor: RedditorReference,
    permissions: readonly ModeratorPermission[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertModeratorAccess(this.client, "moderator.update()");
    return this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/api/setpermissions/`,
      data: {
        name: referenceString(redditor, "redditor"),
        permissions: permissions.join(","),
        type: "moderator",
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  updateInvite(
    redditor: RedditorReference,
    permissions: readonly ModeratorPermission[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertModeratorAccess(this.client, "moderator.updateInvite()");
    return this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/api/setpermissions/`,
      data: {
        name: referenceString(redditor, "redditor"),
        permissions: permissions.join(","),
        type: "moderator_invite",
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  remove(redditor: RedditorReference, signal?: AbortSignal): Promise<unknown> {
    return this.unfriend(redditor, "moderator", signal);
  }

  removeInvite(
    redditor: RedditorReference,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.unfriend(redditor, "moderator_invite", signal);
  }

  private friend(
    redditor: RedditorReference,
    permissions: readonly ModeratorPermission[],
    type: "moderator" | "moderator_invite",
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertModeratorAccess(
      this.client,
      `moderator.${type === "moderator" ? "add" : "invite"}()`,
    );
    return this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/api/friend/`,
      data: {
        name: referenceString(redditor, "redditor"),
        permissions: permissions.join(","),
        type,
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private unfriend(
    redditor: RedditorReference,
    type: "moderator" | "moderator_invite",
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertModeratorAccess(this.client, "moderator.remove()");
    return this.client.request({
      method: "POST",
      path: `/r/${subredditPath(this.subreddit)}/api/unfriend/`,
      data: { name: referenceString(redditor, "redditor"), type },
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export interface SubredditRelationships {
  readonly banned: SubredditRelationship;
  readonly contributor: ContributorRelationship;
  readonly moderator: ModeratorRelationship;
  readonly muted: SubredditRelationship;
  readonly wikibanned: SubredditRelationship;
  readonly wikicontributor: SubredditRelationship;
}

export function createSubredditRelationships(
  client: ModerationClientLike,
  subreddit: SubredditReference,
): SubredditRelationships {
  return {
    banned: new SubredditRelationship(client, subreddit, "banned"),
    contributor: new ContributorRelationship(client, subreddit),
    moderator: new ModeratorRelationship(client, subreddit),
    muted: new SubredditRelationship(client, subreddit, "muted"),
    wikibanned: new SubredditRelationship(client, subreddit, "wikibanned"),
    wikicontributor: new SubredditRelationship(
      client,
      subreddit,
      "wikicontributor",
    ),
  };
}
