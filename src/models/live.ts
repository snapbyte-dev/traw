import { ReadOnlyException } from "../exceptions.js";
import {
  Listing,
  type ListingOptions,
  type ListingPageAdapter,
} from "../listing.js";
import { Objector } from "../objector.js";
import { pollingStream, type StreamOptions } from "../stream.js";
import {
  BaseModel,
  isRawData,
  type RawData,
  type RedditClientLike,
} from "./base.js";

export interface LiveClient extends RedditClientLike {
  readonly readOnly?: boolean;
}

export type LivePermission =
  | "access"
  | "all"
  | "close"
  | "discussions"
  | "edit"
  | "manage"
  | "settings"
  | "update";

export type LiveReportReason =
  | "personal-information"
  | "sexualizing-minors"
  | "site-breaking"
  | "spam"
  | "vote-manipulation";

export interface LiveThreadUpdateOptions {
  readonly description?: string;
  readonly nsfw?: boolean;
  readonly resources?: string;
  readonly signal?: AbortSignal;
  readonly title?: string;
}

export type LiveContributorReference =
  | string
  | {
      readonly fullname?: string;
      readonly toString: () => string;
    };

const REPORT_REASONS: readonly LiveReportReason[] = [
  "personal-information",
  "sexualizing-minors",
  "site-breaking",
  "spam",
  "vote-manipulation",
];

function authorized(client: LiveClient, operation: string): void {
  if (client.readOnly === true)
    throw new ReadOnlyException(`${operation} does not work in read-only mode`);
}

export function requiredLiveString(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} cannot be empty`);
  return normalized;
}

function pathId(value: string, name: string): string {
  return encodeURIComponent(requiredLiveString(value, name));
}

function unwrap(value: unknown): unknown {
  let result = value;
  if (isRawData(result) && isRawData(result["json"])) result = result["json"];
  if (isRawData(result) && isRawData(result["data"])) result = result["data"];
  return result;
}

function modelData(value: unknown, name: string): RawData {
  const result = unwrap(value);
  if (!isRawData(result))
    throw new TypeError(`Reddit returned invalid ${name} data`);
  return result;
}

function responseChild(value: unknown, name: string): RawData {
  let result = value;
  if (isRawData(result) && result["kind"] === "Listing")
    result = result["data"];
  if (isRawData(result) && Array.isArray(result["children"])) {
    const child: unknown = result["children"][0];
    if (isRawData(child) && isRawData(child["data"])) return child["data"];
    if (isRawData(child)) return child;
    throw new TypeError(`Reddit returned invalid ${name} data`);
  }
  return modelData(value, name);
}

async function post(
  client: LiveClient,
  operation: string,
  path: string,
  data?: Readonly<Record<string, boolean | string>>,
  signal?: AbortSignal,
): Promise<void> {
  authorized(client, operation);
  signal?.throwIfAborted();
  const response = await client.request({
    method: "POST",
    path,
    ...(data === undefined ? {} : { data }),
    ...(signal === undefined ? {} : { signal }),
  });
  new Objector(client).objectify(response);
}

function permissionData(permissions?: readonly LivePermission[]): string {
  const values = permissions ?? ["all"];
  const unique = new Set<string>();
  for (const permission of values) {
    const normalized = requiredLiveString(permission, "permission");
    if ([",", "+", "-"].some((token) => normalized.includes(token)))
      throw new TypeError(`Invalid live contributor permission: ${permission}`);
    unique.add(normalized);
  }
  return [...unique].map((permission) => `+${permission}`).join(",");
}

function contributorName(value: LiveContributorReference): string {
  return requiredLiveString(String(value), "redditor");
}

function contributorFullname(value: LiveContributorReference): string {
  const candidate = typeof value === "string" ? value : value.fullname;
  if (candidate === undefined)
    throw new TypeError("A redditor fullname is required");
  const fullname = requiredLiveString(candidate, "redditor fullname");
  if (!/^t2_[a-z0-9]+$/i.test(fullname))
    throw new TypeError("redditor fullname must start with t2_");
  return fullname;
}

const userListPageAdapter: ListingPageAdapter = {
  childKind: "LiveContributor",
  childName: "live contributor",
  cursorParam: "after",
  page(value) {
    let data = value;
    if (isRawData(data) && data["kind"] === "UserList") data = data["data"];
    if (!isRawData(data) || !Array.isArray(data["children"]))
      throw new TypeError("Reddit returned invalid live contributors data");
    const after = data["after"];
    if (after !== undefined && after !== null && typeof after !== "string")
      throw new TypeError("Reddit returned invalid live contributors cursor");
    return { children: data["children"], cursor: after ?? null };
  },
};

export class LiveContributor extends BaseModel {
  declare readonly id?: string;
  declare readonly name?: string;
  declare readonly permissions?: readonly LivePermission[];

  get fullname(): string | undefined {
    const name = this.get("fullname") ?? this.get("id");
    if (typeof name !== "string" || name.length === 0) return undefined;
    return name.startsWith("t2_") ? name : `t2_${name}`;
  }

  override toString(): string {
    const name = this.get("name");
    if (typeof name !== "string" || name.length === 0)
      throw new TypeError("LiveContributor has no valid name");
    return name;
  }
}

export class LiveDiscussion extends BaseModel {
  declare readonly id?: string;
  declare readonly name?: string;
  declare readonly title?: string;

  get fullname(): string {
    const name = this.get("name");
    if (typeof name === "string" && name.length > 0) return name;
    const id = this.get("id");
    if (typeof id !== "string" || id.length === 0)
      throw new TypeError("LiveDiscussion has no valid identity");
    return id.startsWith("t3_") ? id : `t3_${id}`;
  }

  override toString(): string {
    return this.fullname;
  }
}

export class LiveThread extends BaseModel {
  declare readonly created_utc?: number;
  declare readonly description?: string;
  declare readonly description_html?: string;
  declare readonly nsfw?: boolean;
  declare readonly resources?: string;
  declare readonly resources_html?: string;
  declare readonly title?: string;

  readonly #client: LiveClient;
  #loaded: boolean;

  constructor(client: LiveClient, value: string | RawData) {
    const data =
      typeof value === "string"
        ? { id: requiredLiveString(value, "live thread ID") }
        : value;
    super(client, data);
    this.#client = client;
    this.#loaded = typeof value !== "string";
    void this.id;
  }

  get id(): string {
    const id = this.get("id");
    if (typeof id !== "string" || id.length === 0)
      throw new TypeError("LiveThread has no valid ID");
    return id;
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  get contrib(): LiveThreadContribution {
    return new LiveThreadContribution(this);
  }

  get contribution(): LiveThreadContribution {
    return this.contrib;
  }

  get contributor(): LiveContributorRelationship {
    return new LiveContributorRelationship(this);
  }

  get stream(): LiveThreadStream {
    return new LiveThreadStream(this);
  }

  override toString(): string {
    return this.id;
  }

  update(updateId: string): LiveUpdate {
    return new LiveUpdate(this.#client, this, updateId);
  }

  async load(options: { readonly signal?: AbortSignal } = {}): Promise<this> {
    if (this.#loaded) return this;
    return this.refresh(options);
  }

  async refresh(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<this> {
    options.signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: `/api/live/${pathId(this.id, "live thread ID")}/about/`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const data = modelData(response, "live thread");
    if (typeof data["id"] !== "string") data["id"] = this.id;
    this.applyData(data);
    this.#loaded = true;
    return this;
  }

  updates(options: ListingOptions = {}): Listing<LiveUpdate> {
    return new Listing(
      this.#client,
      `/live/${pathId(this.id, "live thread ID")}`,
      {
        ...options,
        objector: new Objector(this.#client, {
          LiveUpdate: (client, data) => new LiveUpdate(client, this, data),
        }),
      },
    );
  }

  discussions(options: ListingOptions = {}): Listing<LiveDiscussion> {
    return new Listing(
      this.#client,
      `/live/${pathId(this.id, "live thread ID")}/discussions`,
      {
        ...options,
        objector: new Objector(this.#client, {
          t3: (client, data) => new LiveDiscussion(client, data),
        }),
      },
    );
  }

  report(reason: LiveReportReason, signal?: AbortSignal): Promise<void> {
    authorized(this.#client, "liveThread.report()");
    if (!REPORT_REASONS.includes(reason))
      throw new RangeError(`Invalid live thread report reason: ${reason}`);
    return post(
      this.#client,
      "liveThread.report()",
      `/api/live/${pathId(this.id, "live thread ID")}/report`,
      { type: reason },
      signal,
    );
  }
}

export class LiveUpdate extends BaseModel {
  declare readonly author?: LiveContributor;
  declare readonly body?: string;
  declare readonly body_html?: string;
  declare readonly created_utc?: number;
  declare readonly stricken?: boolean;

  readonly #client: LiveClient;
  readonly thread: LiveThread;
  #loaded: boolean;

  constructor(
    client: LiveClient,
    thread: LiveThread | string,
    value: string | RawData,
  ) {
    const data =
      typeof value === "string"
        ? { id: requiredLiveString(value, "live update ID") }
        : LiveUpdate.objectifyData(client, value);
    super(client, data);
    this.#client = client;
    this.thread =
      typeof thread === "string" ? new LiveThread(client, thread) : thread;
    this.#loaded = typeof value !== "string";
    void this.id;
  }

  get id(): string {
    const id = this.get("id");
    if (typeof id !== "string" || id.length === 0)
      throw new TypeError("LiveUpdate has no valid ID");
    return id.replace(/^LiveUpdate_/, "");
  }

  get fullname(): string {
    return `LiveUpdate_${this.id}`;
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  get contrib(): LiveUpdateContribution {
    return new LiveUpdateContribution(this);
  }

  get contribution(): LiveUpdateContribution {
    return this.contrib;
  }

  override toString(): string {
    return this.id;
  }

  async load(options: { readonly signal?: AbortSignal } = {}): Promise<this> {
    if (this.#loaded) return this;
    return this.refresh(options);
  }

  async refresh(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<this> {
    options.signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: `/live/${pathId(this.thread.id, "live thread ID")}/updates/${pathId(this.id, "live update ID")}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const data = LiveUpdate.objectifyData(
      this.#client,
      responseChild(response, "live update"),
    );
    if (typeof data["id"] !== "string") data["id"] = this.id;
    this.applyData(data);
    this.#loaded = true;
    return this;
  }

  remove(signal?: AbortSignal): Promise<void> {
    return this.contrib.remove(signal);
  }

  strike(signal?: AbortSignal): Promise<void> {
    return this.contrib.strike(signal);
  }

  private static objectifyData(client: LiveClient, data: RawData): RawData {
    const author = data["author"];
    return {
      ...data,
      ...(typeof author === "string"
        ? { author: new LiveContributor(client, { name: author }) }
        : {}),
    };
  }
}

export class LiveThreadContribution {
  readonly thread: LiveThread;

  constructor(thread: LiveThread) {
    this.thread = thread;
  }

  add(body: string, signal?: AbortSignal): Promise<void> {
    const client = this.thread.client;
    authorized(client, "liveThread.contrib.add()");
    return post(
      client,
      "liveThread.contrib.add()",
      `/api/live/${pathId(this.thread.id, "live thread ID")}/update`,
      { body: requiredLiveString(body, "body") },
      signal,
    );
  }

  close(signal?: AbortSignal): Promise<void> {
    return post(
      this.thread.client,
      "liveThread.contrib.close()",
      `/api/live/${pathId(this.thread.id, "live thread ID")}/close_thread`,
      undefined,
      signal,
    );
  }

  async update(options: LiveThreadUpdateOptions = {}): Promise<void> {
    const { description, nsfw, resources, signal, title } = options;
    if (
      description === undefined &&
      nsfw === undefined &&
      resources === undefined &&
      title === undefined
    )
      return;
    authorized(this.thread.client, "liveThread.contrib.update()");
    signal?.throwIfAborted();
    const current = new LiveThread(this.thread.client, this.thread.id);
    await current.load({ ...(signal === undefined ? {} : { signal }) });
    const nextTitle = title ?? current.get("title");
    if (typeof nextTitle !== "string")
      throw new TypeError("Live thread settings have no valid title");
    const normalizedTitle = requiredLiveString(nextTitle, "title");
    if (normalizedTitle.length > 120)
      throw new RangeError("title cannot exceed 120 characters");
    const data = {
      description: description ?? current.get<string>("description") ?? "",
      nsfw: nsfw ?? current.get<boolean>("nsfw") ?? false,
      resources: resources ?? current.get<string>("resources") ?? "",
      title: normalizedTitle,
    };
    await post(
      this.thread.client,
      "liveThread.contrib.update()",
      `/api/live/${pathId(this.thread.id, "live thread ID")}/edit`,
      data,
      signal,
    );
  }
}

export class LiveUpdateContribution {
  readonly update: LiveUpdate;

  constructor(update: LiveUpdate) {
    this.update = update;
  }

  remove(signal?: AbortSignal): Promise<void> {
    return this.action("delete_update", "remove", signal);
  }

  strike(signal?: AbortSignal): Promise<void> {
    return this.action("strike_update", "strike", signal);
  }

  private action(
    endpoint: "delete_update" | "strike_update",
    operation: "remove" | "strike",
    signal?: AbortSignal,
  ): Promise<void> {
    return post(
      this.update.client,
      `liveUpdate.${operation}()`,
      `/api/live/${pathId(this.update.thread.id, "live thread ID")}/${endpoint}`,
      { id: this.update.fullname },
      signal,
    );
  }
}

export class LiveContributorRelationship {
  readonly thread: LiveThread;

  constructor(thread: LiveThread) {
    this.thread = thread;
  }

  list(options: ListingOptions = {}): Listing<LiveContributor> {
    return new Listing(
      this.thread.client,
      `/live/${pathId(this.thread.id, "live thread ID")}/contributors`,
      {
        ...options,
        objector: new Objector(this.thread.client, {
          LiveContributor: (client, data) => new LiveContributor(client, data),
        }),
        pageAdapter: userListPageAdapter,
      },
    );
  }

  invite(
    redditor: LiveContributorReference,
    permissions?: readonly LivePermission[],
    signal?: AbortSignal,
  ): Promise<void> {
    return this.permissionsAction(
      "invite_contributor",
      "invite",
      "liveupdate_contributor_invite",
      redditor,
      permissions,
      signal,
    );
  }

  update(
    redditor: LiveContributorReference,
    permissions?: readonly LivePermission[],
    signal?: AbortSignal,
  ): Promise<void> {
    return this.permissionsAction(
      "set_contributor_permissions",
      "update",
      "liveupdate_contributor",
      redditor,
      permissions,
      signal,
    );
  }

  updateInvite(
    redditor: LiveContributorReference,
    permissions?: readonly LivePermission[],
    signal?: AbortSignal,
  ): Promise<void> {
    return this.permissionsAction(
      "set_contributor_permissions",
      "updateInvite",
      "liveupdate_contributor_invite",
      redditor,
      permissions,
      signal,
    );
  }

  remove(
    redditor: LiveContributorReference,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.removeAction("rm_contributor", "remove", redditor, signal);
  }

  removeInvite(
    redditor: LiveContributorReference,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.removeAction(
      "rm_contributor_invite",
      "removeInvite",
      redditor,
      signal,
    );
  }

  leave(signal?: AbortSignal): Promise<void> {
    return post(
      this.thread.client,
      "liveThread.contributor.leave()",
      `/api/live/${pathId(this.thread.id, "live thread ID")}/leave_contributor`,
      undefined,
      signal,
    );
  }

  acceptInvite(signal?: AbortSignal): Promise<void> {
    return post(
      this.thread.client,
      "liveThread.contributor.acceptInvite()",
      `/api/live/${pathId(this.thread.id, "live thread ID")}/accept_contributor_invite`,
      undefined,
      signal,
    );
  }

  private permissionsAction(
    endpoint: "invite_contributor" | "set_contributor_permissions",
    operation: "invite" | "update" | "updateInvite",
    type: "liveupdate_contributor" | "liveupdate_contributor_invite",
    redditor: LiveContributorReference,
    permissions?: readonly LivePermission[],
    signal?: AbortSignal,
  ): Promise<void> {
    authorized(this.thread.client, `liveThread.contributor.${operation}()`);
    return post(
      this.thread.client,
      `liveThread.contributor.${operation}()`,
      `/api/live/${pathId(this.thread.id, "live thread ID")}/${endpoint}`,
      {
        name: contributorName(redditor),
        permissions: permissionData(permissions),
        type,
      },
      signal,
    );
  }

  private removeAction(
    endpoint: "rm_contributor" | "rm_contributor_invite",
    operation: "remove" | "removeInvite",
    redditor: LiveContributorReference,
    signal?: AbortSignal,
  ): Promise<void> {
    authorized(this.thread.client, `liveThread.contributor.${operation}()`);
    return post(
      this.thread.client,
      `liveThread.contributor.${operation}()`,
      `/api/live/${pathId(this.thread.id, "live thread ID")}/${endpoint}`,
      { id: contributorFullname(redditor) },
      signal,
    );
  }
}

export class LiveThreadStream {
  readonly thread: LiveThread;

  constructor(thread: LiveThread) {
    this.thread = thread;
  }

  updates(
    options: ListingOptions & StreamOptions<LiveUpdate> = {},
  ): AsyncGenerator<LiveUpdate | null> {
    return pollingStream(
      ({ before, limit, signal }) =>
        this.thread.updates({
          ...options,
          limit,
          params: {
            ...options.params,
            ...(before === undefined ? {} : { before }),
          },
          ...(signal === undefined ? {} : { signal }),
        }),
      { ...options, attribute: "fullname" },
    );
  }
}
