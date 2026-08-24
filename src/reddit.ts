import { Config, type ConfigOptions } from "./config.js";
import { Auth } from "./core/auth.js";
import { systemClock, type Clock } from "./core/clock.js";
import { FetchTransport } from "./core/fetch-transport.js";
import { Session, type HeaderProvider } from "./core/session.js";
import type { JsonValue, ReplayableBody, Transport } from "./core/transport.js";
import { ClientException, RedditAPIException } from "./exceptions.js";
import {
  InboxDomain,
  RedditorsDomain,
  SubredditsDomain,
  UserDomain,
  createAnnouncementsDomain,
  createDraftsDomain,
  createLiveDomain,
  createMultiredditDomain,
  createNotesDomain,
  type AnnouncementsDomain,
  type DraftsDomain,
  type LiveDomain,
  type MultiredditDomain,
  type NotesDomain,
} from "./domains.js";
import {
  Domain,
  Front,
  InfoListing,
  ListingRedditor,
  createSubredditHelper,
  type InfoOptions,
  type SubredditHelper,
} from "./helpers.js";
import { Comment, Submission } from "./models/entities.js";
import type { DataValue, QueryValue, RedditRequest } from "./models/base.js";
import { Objector } from "./objector.js";

type Parameter = boolean | number | string;
type ParameterValue = Parameter | readonly Parameter[];
type Parameters = Readonly<Record<string, QueryValue | readonly Parameter[]>>;
type Data = Readonly<Record<string, DataValue>>;

export interface ClosableTransport extends Transport {
  close?(): Promise<void> | void;
}

export interface RedditHeaderProvider extends HeaderProvider {
  readonly readOnly?: boolean;
  setReadOnly?(value: boolean): void;
}

interface RedditDependencies {
  readonly clock?: Clock;
  readonly headerProvider?: RedditHeaderProvider;
  readonly transport?: ClosableTransport;
}

export type RedditOptions = RedditDependencies &
  (
    | { readonly config: Config }
    | (ConfigOptions & {
        readonly clientId: string;
        readonly clientSecret: string | null;
        readonly config?: never;
        readonly userAgent: string;
      })
  );

export interface RequestOptions {
  readonly auth?: boolean;
  readonly data?: Data | ReplayableBody;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: JsonValue;
  readonly method: string;
  readonly params?: Parameters;
  readonly path: string;
  readonly rawJson?: boolean;
  readonly responseType?: "json" | "text";
  readonly signal?: AbortSignal;
}

export type MethodOptions = Omit<RequestOptions, "method" | "path">;

export interface ThingOptions {
  readonly id?: string;
  readonly url?: string;
}

function idFromUrl(value: string, type: "comment" | "submission"): string {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  const comments = parts.indexOf("comments");
  const index = type === "submission" ? comments + 1 : comments + 3;
  const id =
    comments >= 0
      ? parts[index]
      : url.hostname === "redd.it"
        ? parts[0]
        : undefined;
  if (id === undefined || id.length === 0)
    throw new TypeError(`URL does not contain a ${type} ID`);
  return id;
}

function thingId(
  value: string | ThingOptions,
  type: "comment" | "submission",
): string {
  if (typeof value === "string") return value;
  if ((value.id === undefined) === (value.url === undefined)) {
    throw new TypeError("Exactly one of id or url must be provided");
  }
  if (value.id !== undefined) return value.id;
  if (value.url !== undefined) return idFromUrl(value.url, type);
  throw new TypeError("Exactly one of id or url must be provided");
}

function methodOptions(
  method: string,
  path: string,
  options: MethodOptions,
): RequestOptions {
  return { method, path, ...options };
}

function requestParameters(
  parameters: Parameters | undefined,
): Readonly<Record<string, ParameterValue>> | undefined {
  if (parameters === undefined) return undefined;
  const result: Record<string, ParameterValue> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== null && value !== undefined) result[key] = value;
  }
  return result;
}

/** Initial PRAW-compatible facade over the transport/session/model layers. */
export class Reddit {
  static readonly #ratelimitPattern =
    /([0-9]{1,3}) (milliseconds?|seconds?|minutes?)/;

  readonly announcements: AnnouncementsDomain;
  readonly auth: Auth;
  readonly config: Config;
  readonly drafts: DraftsDomain;
  readonly front: Front;
  readonly inbox: InboxDomain;
  readonly live: LiveDomain;
  readonly multireddit: MultiredditDomain;
  readonly notes: NotesDomain;
  readonly redditors: RedditorsDomain;
  readonly subreddit: SubredditHelper;
  readonly subreddits: SubredditsDomain;
  readonly user: UserDomain;
  readonly #headerProvider: RedditHeaderProvider;
  readonly #clock: Clock;
  readonly #objector: Objector;
  readonly #session: Session;
  readonly #transport: ClosableTransport;
  #closed = false;

  constructor(options: RedditOptions);
  constructor(
    config: Config,
    transport: ClosableTransport,
    headerProvider?: RedditHeaderProvider,
  );
  constructor(
    optionsOrConfig: RedditOptions | Config,
    transport?: ClosableTransport,
    headerProvider?: RedditHeaderProvider,
  ) {
    let options: RedditOptions;
    if (optionsOrConfig instanceof Config) {
      if (transport === undefined) throw new TypeError("transport is required");
      options = {
        config: optionsOrConfig,
        transport,
        ...(headerProvider === undefined ? {} : { headerProvider }),
      };
    } else {
      options = optionsOrConfig;
    }

    this.config = options.config ?? new Config(options);
    this.#clock = options.clock ?? systemClock;
    this.#transport =
      options.transport ??
      new FetchTransport(fetch, { timeoutMs: this.config.timeout * 1_000 });
    this.auth = new Auth({ config: this.config, transport: this.#transport });
    this.#headerProvider = options.headerProvider ?? this.auth;
    this.#session = new Session({
      baseUrl: this.config.oauthUrl,
      clock: this.#clock,
      headerProvider: this.#headerProvider,
      transport: this.#transport,
      windowSizeMs: this.config.windowSize * 1_000,
      headers: { "User-Agent": this.config.userAgent },
    });
    this.auth.bindRateLimiter(this.#session.rateLimiter);
    this.#objector = new Objector(this);
    this.announcements = createAnnouncementsDomain(this);
    this.drafts = createDraftsDomain(this);
    this.front = new Front(this);
    this.inbox = new InboxDomain(this);
    this.live = createLiveDomain(this);
    this.multireddit = createMultiredditDomain(this);
    this.notes = createNotesDomain(this);
    this.redditors = new RedditorsDomain(this);
    this.subreddit = createSubredditHelper(this);
    this.subreddits = new SubredditsDomain(this);
    this.user = new UserDomain(this);
  }

  get readOnly(): boolean {
    return this.#headerProvider.readOnly ?? true;
  }

  set readOnly(value: boolean) {
    if (value === this.readOnly) return;
    if (this.#headerProvider.setReadOnly === undefined) {
      throw new ClientException(
        "readOnly cannot be changed by the active header provider",
      );
    }
    this.#headerProvider.setReadOnly(value);
  }

  comment(value: string | ThingOptions): Comment {
    return new Comment(this, thingId(value, "comment"));
  }

  submission(value: string | ThingOptions): Submission {
    return new Submission(this, thingId(value, "submission"));
  }

  redditor(name: string): ListingRedditor {
    return new ListingRedditor(this, name);
  }

  domain(name: string): Domain {
    return new Domain(this, name);
  }

  info(options: InfoOptions): InfoListing {
    return new InfoListing(this, options);
  }

  async usernameAvailable(
    name: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.get("/api/username_available", {
      params: { user: name },
      ...(signal === undefined ? {} : { signal }),
    });
    if (typeof result !== "boolean")
      throw new TypeError("Reddit returned a non-boolean username result");
    return result;
  }

  request(request: RedditRequest): Promise<unknown>;
  request(options: RequestOptions): Promise<JsonValue | string | null>;
  async request(
    options: RequestOptions | RedditRequest,
  ): Promise<JsonValue | string | null> {
    if (this.#closed) throw new Error("Reddit client is closed");
    const { params: originalParams, ...request } = options;
    const params = requestParameters(originalParams);
    return this.#session.request({
      ...request,
      ...(params === undefined ? {} : { params }),
    });
  }

  async get(
    path: string,
    options: Omit<MethodOptions, "data" | "json"> = {},
  ): Promise<unknown> {
    return this.objectified(methodOptions("GET", path, options));
  }

  async post(path: string, options: MethodOptions = {}): Promise<unknown> {
    let attemptsRemaining = 3;
    for (;;) {
      try {
        return await this.objectified(methodOptions("POST", path, options));
      } catch (error) {
        if (!(error instanceof RedditAPIException)) throw error;
        const delaySeconds = this.rateLimitDelay(error);
        if (delaySeconds === undefined) throw error;
        await this.#clock.sleep(delaySeconds * 1_000, options.signal);
        attemptsRemaining -= 1;
        if (attemptsRemaining === 0) throw error;
      }
    }
  }

  async put(path: string, options: MethodOptions = {}): Promise<unknown> {
    return this.objectified(methodOptions("PUT", path, options));
  }

  async patch(path: string, options: MethodOptions = {}): Promise<unknown> {
    return this.objectified(methodOptions("PATCH", path, options));
  }

  async delete(path: string, options: MethodOptions = {}): Promise<unknown> {
    return this.objectified(methodOptions("DELETE", path, options));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport.close?.();
  }

  private async objectified(options: RequestOptions): Promise<unknown> {
    return this.#objector.objectify(await this.request(options));
  }

  private rateLimitDelay(exception: RedditAPIException): number | undefined {
    for (const item of exception.items) {
      if (item.errorType !== "RATELIMIT" || item.message === null) continue;
      const match = Reddit.#ratelimitPattern.exec(item.message);
      if (match === null) break;
      const [amountText, unit] = match.slice(1) as [string, string];
      const amount = Number.parseInt(amountText, 10);
      const seconds = unit.startsWith("minute")
        ? amount * 60
        : unit.startsWith("millisecond")
          ? 0
          : amount;
      return seconds <= this.config.ratelimitSeconds ? seconds + 1 : undefined;
    }
    return undefined;
  }
}
