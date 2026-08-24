import { replayableJson } from "../core/transport.js";
import { Multireddit, type MultiredditClient } from "../models/multireddit.js";
import { ConflictError, ReadOnlyError } from "../exceptions.js";
import { Listing, type ListingOptions } from "../listing.js";
import {
  BaseModel,
  isRawData,
  type DataValue,
  type RawData,
  type RedditClientLike,
} from "../models/base.js";
import { Redditor, Submission, Subreddit } from "../models/entities.js";
import { Objector } from "../objector.js";

export interface AccountClient extends RedditClientLike {
  readonly readOnly: boolean;
}

export type AccountPreferenceValue = boolean | number | string;
export type AccountPreferences = Readonly<
  Record<string, AccountPreferenceValue>
>;

export interface CommunityKarma {
  readonly commentKarma: number;
  readonly linkKarma: number;
}

export interface MeOptions {
  readonly signal?: AbortSignal;
  readonly useCache?: boolean;
}

export interface FriendOptions {
  readonly note?: string;
  readonly signal?: AbortSignal;
}

export interface PinOptions {
  readonly num?: number;
  readonly signal?: AbortSignal;
}

export class Trophy extends BaseModel {}

export class PreferencesDomain {
  readonly #client: AccountClient;

  constructor(client: AccountClient) {
    this.#client = client;
  }

  async get(signal?: AbortSignal): Promise<AccountPreferences> {
    assertAuthorized(this.#client, "account.preferences.get()");
    const response = await this.#client.request({
      method: "GET",
      path: "/api/v1/me/prefs",
      ...signalOptions(signal),
    });
    return preferencesData(response);
  }

  async update(
    preferences: AccountPreferences,
    signal?: AbortSignal,
  ): Promise<AccountPreferences> {
    assertAuthorized(this.#client, "account.preferences.update()");
    const response = await this.#client.request({
      method: "PATCH",
      path: "/api/v1/me/prefs",
      data: { json: JSON.stringify(preferences) },
      ...signalOptions(signal),
    });
    return preferencesData(response);
  }
}

function assertAuthorized(client: AccountClient, operation: string): void {
  if (client.readOnly) {
    throw new ReadOnlyError(`${operation} does not work in read-only mode`);
  }
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return normalized;
}

function username(value: string | Redditor): string {
  return nonEmpty(String(value), "redditor");
}

function signalOptions(signal?: AbortSignal): {
  readonly signal?: AbortSignal;
} {
  signal?.throwIfAborted();
  return signal === undefined ? {} : { signal };
}

function responseData(value: unknown): unknown {
  if (isRawData(value) && "data" in value) return value["data"];
  return value;
}

function rawModel(value: unknown, model: string): RawData {
  let data = value;
  if (isRawData(data) && isRawData(data["data"])) data = data["data"];
  if (isRawData(data)) return data;
  throw new TypeError(`Reddit returned invalid ${model} data`);
}

function rawArray(value: unknown, field: string, model: string): unknown[] {
  let data = responseData(value);
  if (isRawData(data) && Array.isArray(data[field])) data = data[field];
  if (isRawData(data) && Array.isArray(data["children"])) {
    data = data["children"];
  }
  if (!Array.isArray(data)) {
    throw new TypeError(`Reddit returned invalid ${model} data`);
  }
  return data;
}

function preferencesData(value: unknown): AccountPreferences {
  if (!isRawData(value)) {
    throw new TypeError("Reddit returned invalid preferences data");
  }
  const result: Record<string, AccountPreferenceValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item !== "boolean" &&
      typeof item !== "number" &&
      typeof item !== "string"
    ) {
      throw new TypeError("Reddit returned invalid preferences data");
    }
    result[key] = item;
  }
  return result;
}

function redditorData(value: unknown): RawData {
  const data = rawModel(value, "redditor");
  if (typeof data["name"] !== "string") {
    throw new TypeError("Reddit returned invalid redditor data");
  }
  return data;
}

function redditorList(client: RedditClientLike, value: unknown): Redditor[] {
  return rawArray(value, "children", "redditor list").map((item) => {
    const objectified = new Objector(client).objectify(item);
    return objectified instanceof Redditor
      ? objectified
      : new Redditor(client, redditorData(item));
  });
}

function subredditList(client: RedditClientLike, value: unknown): Subreddit[] {
  if (value === null || value === "") return [];
  return rawArray(value, "children", "subreddit list").map((item) => {
    const objectified = new Objector(client).objectify(item);
    const data = rawModel(item, "subreddit");
    if (objectified instanceof Subreddit) return objectified;
    if (typeof data["display_name"] !== "string") {
      throw new TypeError("Reddit returned invalid subreddit data");
    }
    return new Subreddit(client, data);
  });
}

function multiredditList(
  client: MultiredditClient,
  value: unknown,
): Multireddit[] {
  return rawArray(value, "children", "multireddit list").map((item) => {
    const data = rawModel(item, "multireddit");
    if (typeof data["name"] !== "string" || typeof data["path"] !== "string") {
      throw new TypeError("Reddit returned invalid multireddit data");
    }
    return new Multireddit(client, data);
  });
}

async function relationshipRequest(
  client: AccountClient,
  operation: string,
  method: "DELETE" | "POST" | "PUT",
  path: string,
  options: {
    readonly data?: Readonly<Record<string, DataValue>>;
    readonly json?: Readonly<Record<string, AccountPreferenceValue>>;
    readonly params?: Readonly<Record<string, DataValue>>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  assertAuthorized(client, operation);
  const { json, ...requestOptions } = options;
  await client.request({
    method,
    path,
    ...requestOptions,
    ...(json === undefined ? {} : { data: replayableJson(json) }),
    ...signalOptions(options.signal),
  });
}

export function blockRedditor(
  client: AccountClient,
  redditor: string | Redditor,
  signal?: AbortSignal,
): Promise<void> {
  assertAuthorized(client, "redditor.block()");
  return relationshipRequest(
    client,
    "redditor.block()",
    "POST",
    "/api/block_user/",
    { params: { name: username(redditor) }, ...signalOptions(signal) },
  );
}

export async function unblockRedditor(
  client: AccountClient,
  redditor: string | Redditor,
  signal?: AbortSignal,
): Promise<void> {
  assertAuthorized(client, "redditor.unblock()");
  const meResponse = await client.request({
    method: "GET",
    path: "/api/v1/me",
    ...signalOptions(signal),
  });
  const me = redditorData(meResponse);
  const id = me["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("Reddit returned current redditor without an ID");
  }
  await relationshipRequest(
    client,
    "redditor.unblock()",
    "POST",
    "/r/all/api/unfriend/",
    {
      data: { container: `t2_${id}`, name: username(redditor), type: "enemy" },
      ...signalOptions(signal),
    },
  );
}

export function friendRedditor(
  client: AccountClient,
  redditor: string | Redditor,
  options: FriendOptions = {},
): Promise<void> {
  assertAuthorized(client, "redditor.friend()");
  const name = username(redditor);
  return relationshipRequest(
    client,
    "redditor.friend()",
    "PUT",
    `/api/v1/me/friends/${encodeURIComponent(name)}`,
    {
      json: options.note === undefined ? {} : { note: options.note },
      ...signalOptions(options.signal),
    },
  );
}

export function unfriendRedditor(
  client: AccountClient,
  redditor: string | Redditor,
  signal?: AbortSignal,
): Promise<void> {
  assertAuthorized(client, "redditor.unfriend()");
  const name = username(redditor);
  return relationshipRequest(
    client,
    "redditor.unfriend()",
    "DELETE",
    `/api/v1/me/friends/${encodeURIComponent(name)}`,
    { json: { id: name }, ...signalOptions(signal) },
  );
}

export async function redditorFriendInfo(
  client: AccountClient,
  redditor: string | Redditor,
  signal?: AbortSignal,
): Promise<Redditor> {
  assertAuthorized(client, "redditor.friendInfo()");
  const response = await client.request({
    method: "GET",
    path: `/api/v1/me/friends/${encodeURIComponent(username(redditor))}`,
    ...signalOptions(signal),
  });
  return new Redditor(client, redditorData(response));
}

export function trustRedditor(
  client: AccountClient,
  redditor: string | Redditor,
  signal?: AbortSignal,
): Promise<void> {
  assertAuthorized(client, "redditor.trust()");
  return relationshipRequest(
    client,
    "redditor.trust()",
    "POST",
    "/api/add_whitelisted",
    { data: { name: username(redditor) }, ...signalOptions(signal) },
  );
}

export function distrustRedditor(
  client: AccountClient,
  redditor: string | Redditor,
  signal?: AbortSignal,
): Promise<void> {
  assertAuthorized(client, "redditor.distrust()");
  return relationshipRequest(
    client,
    "redditor.distrust()",
    "POST",
    "/api/remove_whitelisted",
    { data: { name: username(redditor) }, ...signalOptions(signal) },
  );
}

export async function redditorTrophies(
  client: RedditClientLike,
  redditor: string | Redditor,
  signal?: AbortSignal,
): Promise<Trophy[]> {
  const response = await client.request({
    method: "GET",
    path: `/api/v1/user/${encodeURIComponent(username(redditor))}/trophies`,
    ...signalOptions(signal),
  });
  return rawArray(response, "trophies", "trophy list").map(
    (item) => new Trophy(client, rawModel(item, "trophy")),
  );
}

export async function redditorModeratedCommunities(
  client: RedditClientLike,
  redditor: string | Redditor,
  signal?: AbortSignal,
): Promise<Subreddit[]> {
  const response = await client.request({
    method: "GET",
    path: `/user/${encodeURIComponent(username(redditor))}/moderated_subreddits/`,
    ...signalOptions(signal),
  });
  return subredditList(client, response);
}

export async function redditorPublicMultireddits(
  client: MultiredditClient,
  redditor: string | Redditor,
  signal?: AbortSignal,
): Promise<Multireddit[]> {
  const response = await client.request({
    method: "GET",
    path: `/api/multi/user/${encodeURIComponent(username(redditor))}/`,
    ...signalOptions(signal),
  });
  return multiredditList(client, response);
}

/** Authenticated account capabilities kept independent from the Reddit facade. */
export class AccountDomain {
  readonly preferences: PreferencesDomain;
  readonly #client: AccountClient;
  #me: Redditor | undefined;

  constructor(client: AccountClient) {
    this.#client = client;
    this.preferences = new PreferencesDomain(client);
  }

  async me(options: MeOptions = {}): Promise<Redditor> {
    assertAuthorized(this.#client, "account.me()");
    options.signal?.throwIfAborted();
    if (options.useCache !== false && this.#me !== undefined) return this.#me;
    const response = await this.#client.request({
      method: "GET",
      path: "/api/v1/me",
      ...signalOptions(options.signal),
    });
    const objectified = new Objector(this.#client).objectify(response);
    this.#me =
      objectified instanceof Redditor
        ? objectified
        : new Redditor(this.#client, redditorData(response));
    return this.#me;
  }

  async karma(signal?: AbortSignal): Promise<Map<Subreddit, CommunityKarma>> {
    assertAuthorized(this.#client, "account.karma()");
    const response = await this.#client.request({
      method: "GET",
      path: "/api/v1/me/karma",
      ...signalOptions(signal),
    });
    const rows = rawArray(response, "data", "karma");
    const result = new Map<Subreddit, CommunityKarma>();
    for (const row of rows) {
      if (!isRawData(row))
        throw new TypeError("Reddit returned invalid karma data");
      const community = row["sr"];
      const commentKarma = row["comment_karma"];
      const linkKarma = row["link_karma"];
      if (
        typeof community !== "string" ||
        typeof commentKarma !== "number" ||
        typeof linkKarma !== "number"
      ) {
        throw new TypeError("Reddit returned invalid karma data");
      }
      result.set(new Subreddit(this.#client, community), {
        commentKarma,
        linkKarma,
      });
    }
    return result;
  }

  subreddits(options: ListingOptions = {}): Listing<Subreddit> {
    return this.accountListing(
      "account.subreddits()",
      "/subreddits/mine/subscriber/",
      options,
    );
  }

  contributorCommunities(options: ListingOptions = {}): Listing<Subreddit> {
    return this.accountListing(
      "account.contributorCommunities()",
      "/subreddits/mine/contributor/",
      options,
    );
  }

  moderatorCommunities(options: ListingOptions = {}): Listing<Subreddit> {
    return this.accountListing(
      "account.moderatorCommunities()",
      "/subreddits/mine/moderator/",
      options,
    );
  }

  async friends(signal?: AbortSignal): Promise<Redditor[]>;
  async friends(
    redditor: string | Redditor,
    signal?: AbortSignal,
  ): Promise<Redditor>;
  async friends(
    redditorOrSignal?: string | Redditor | AbortSignal,
    signal?: AbortSignal,
  ): Promise<Redditor[] | Redditor> {
    assertAuthorized(this.#client, "account.friends()");
    const listRequest =
      redditorOrSignal === undefined || redditorOrSignal instanceof AbortSignal;
    const requestSignal =
      redditorOrSignal instanceof AbortSignal ? redditorOrSignal : signal;
    const path = listRequest
      ? "/api/v1/me/friends/"
      : `/api/v1/me/friends/${encodeURIComponent(username(redditorOrSignal))}`;
    const response = await this.#client.request({
      method: "GET",
      path,
      ...signalOptions(requestSignal),
    });
    return listRequest
      ? redditorList(this.#client, response)
      : new Redditor(this.#client, redditorData(response));
  }

  async blocked(signal?: AbortSignal): Promise<Redditor[]> {
    return this.relationshipList(
      "account.blocked()",
      "/prefs/blocked/",
      signal,
    );
  }

  async trusted(signal?: AbortSignal): Promise<Redditor[]> {
    return this.relationshipList("account.trusted()", "/prefs/trusted", signal);
  }

  async pin(
    submission: Submission,
    options: PinOptions = {},
  ): Promise<Submission | undefined> {
    assertAuthorized(this.#client, "account.pin()");
    const data: Record<string, DataValue> = {
      id: submission.fullname,
      state: true,
      to_profile: true,
    };
    if (options.num !== undefined) data["num"] = options.num;
    let response: unknown;
    try {
      response = await this.#client.request({
        method: "POST",
        path: "/api/set_subreddit_sticky/",
        data,
        ...signalOptions(options.signal),
      });
    } catch (error) {
      if (error instanceof ConflictError) return undefined;
      throw error;
    }
    const objectified = new Objector(this.#client).objectify(response);
    return objectified instanceof Submission ? objectified : undefined;
  }

  async unpin(submission: Submission, signal?: AbortSignal): Promise<void> {
    assertAuthorized(this.#client, "account.unpin()");
    await this.#client.request({
      method: "POST",
      path: "/api/set_subreddit_sticky/",
      data: { id: submission.fullname, state: false, to_profile: true },
      ...signalOptions(signal),
    });
  }

  async multireddits(signal?: AbortSignal): Promise<Multireddit[]> {
    assertAuthorized(this.#client, "account.multireddits()");
    const response = await this.#client.request({
      method: "GET",
      path: "/api/multi/mine/",
      ...signalOptions(signal),
    });
    return multiredditList(this.#client, response);
  }

  block(redditor: string | Redditor, signal?: AbortSignal): Promise<void> {
    return blockRedditor(this.#client, redditor, signal);
  }

  unblock(redditor: string | Redditor, signal?: AbortSignal): Promise<void> {
    return unblockRedditor(this.#client, redditor, signal);
  }

  friend(
    redditor: string | Redditor,
    options: FriendOptions = {},
  ): Promise<void> {
    return friendRedditor(this.#client, redditor, options);
  }

  unfriend(redditor: string | Redditor, signal?: AbortSignal): Promise<void> {
    return unfriendRedditor(this.#client, redditor, signal);
  }

  friendInfo(
    redditor: string | Redditor,
    signal?: AbortSignal,
  ): Promise<Redditor> {
    return redditorFriendInfo(this.#client, redditor, signal);
  }

  trust(redditor: string | Redditor, signal?: AbortSignal): Promise<void> {
    return trustRedditor(this.#client, redditor, signal);
  }

  distrust(redditor: string | Redditor, signal?: AbortSignal): Promise<void> {
    return distrustRedditor(this.#client, redditor, signal);
  }

  trophies(
    redditor: string | Redditor,
    signal?: AbortSignal,
  ): Promise<Trophy[]> {
    return redditorTrophies(this.#client, redditor, signal);
  }

  moderatedCommunities(
    redditor: string | Redditor,
    signal?: AbortSignal,
  ): Promise<Subreddit[]> {
    return redditorModeratedCommunities(this.#client, redditor, signal);
  }

  publicMultireddits(
    redditor: string | Redditor,
    signal?: AbortSignal,
  ): Promise<Multireddit[]> {
    return redditorPublicMultireddits(this.#client, redditor, signal);
  }

  private accountListing(
    operation: string,
    path: string,
    options: ListingOptions,
  ): Listing<Subreddit> {
    assertAuthorized(this.#client, operation);
    return new Listing(this.#client, path, options);
  }

  private async relationshipList(
    operation: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Redditor[]> {
    assertAuthorized(this.#client, operation);
    const response = await this.#client.request({
      method: "GET",
      path,
      ...signalOptions(signal),
    });
    return redditorList(this.#client, response);
  }
}
