import { ClientError, MissingRequiredAttributeError } from "./exceptions.js";

type Environment = Readonly<Record<string, string | undefined>>;

const defaults = {
  checkForAsync: true,
  checkForUpdates: true,
  commentKind: "t1",
  messageKind: "t4",
  oauthUrl: "https://oauth.reddit.com",
  ratelimitSeconds: 5,
  redditUrl: "https://www.reddit.com",
  redditorKind: "t2",
  shortUrl: "https://redd.it",
  submissionKind: "t3",
  subredditKind: "t5",
  timeout: 16,
  trophyKind: "t6",
  windowSize: 600,
} as const;

export interface ConfigOptions {
  readonly clientId?: string;
  readonly clientSecret?: string | null;
  readonly userAgent?: string;
  readonly username?: string | null;
  readonly password?: string | null;
  readonly refreshToken?: string | null;
  readonly redirectUri?: string | null;
  readonly oauthUrl?: string;
  readonly redditUrl?: string;
  readonly shortUrl?: string | null;
  readonly ratelimitSeconds?: number;
  readonly timeout?: number;
  readonly windowSize?: number;
  readonly checkForAsync?: boolean;
  readonly checkForUpdates?: boolean;
  readonly allowEndpointOverride?: boolean;
}

function envName(key: string): string {
  return `TRAW_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

function fromEnvironment(env: Environment, key: string): string | undefined {
  const value = env[envName(key)];
  return value === "" ? undefined : value;
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new TypeError(`${name} must be a boolean`);
}

function parsePositiveNumber(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new TypeError(`${name} must be a positive number`);
  return parsed;
}

function optionOrEnv<T>(
  options: ConfigOptions,
  env: Environment,
  key: keyof ConfigOptions,
  parse: (value: string, name: string) => T,
  fallback: T,
): T {
  const option = options[key];
  if (option !== undefined) return option as T;
  const environment = fromEnvironment(env, key);
  return environment === undefined
    ? fallback
    : parse(environment, envName(key));
}

function optionalString(
  options: ConfigOptions,
  env: Environment,
  key: keyof ConfigOptions,
): string | null | undefined {
  const option = options[key];
  if (option !== undefined) return option as string | null;
  return fromEnvironment(env, key);
}

function required(value: string | null | undefined, key: string): string {
  if (value === null || value === undefined || value.trim() === "") {
    throw new MissingRequiredAttributeError(
      `Required configuration setting '${key}' missing. This setting can be provided as a constructor option or as an environment variable.`,
    );
  }
  return value;
}

function endpoint(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:") throw new TypeError(`${name} must use HTTPS`);
  return value.replace(/\/$/, "");
}

export class Config {
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly userAgent: string;
  readonly username: string | null;
  readonly password: string | null;
  readonly refreshToken: string | null;
  readonly redirectUri: string | null;
  readonly oauthUrl: string;
  readonly redditUrl: string;
  readonly ratelimitSeconds: number;
  readonly timeout: number;
  readonly windowSize: number;
  readonly checkForAsync: boolean;
  readonly checkForUpdates: boolean;
  readonly kinds: Readonly<
    Record<
      | "comment"
      | "message"
      | "redditor"
      | "submission"
      | "subreddit"
      | "trophy",
      string
    >
  >;
  readonly #shortUrl: string | null;

  constructor(options: ConfigOptions = {}, env: Environment = process.env) {
    this.clientId = required(
      optionalString(options, env, "clientId"),
      "clientId",
    );
    this.userAgent = required(
      optionalString(options, env, "userAgent"),
      "userAgent",
    );

    const clientSecret = optionalString(options, env, "clientSecret");
    if (clientSecret === undefined) {
      throw new MissingRequiredAttributeError(
        "Required configuration setting 'clientSecret' missing. For installed applications this value must be explicitly set to null as a constructor option.",
      );
    }
    if (typeof clientSecret === "string" && clientSecret.trim() === "") {
      throw new MissingRequiredAttributeError(
        "Configuration setting 'clientSecret' cannot be empty.",
      );
    }
    this.clientSecret = clientSecret;

    this.username = optionalString(options, env, "username") ?? null;
    this.password = optionalString(options, env, "password") ?? null;
    this.refreshToken = optionalString(options, env, "refreshToken") ?? null;
    this.redirectUri = optionalString(options, env, "redirectUri") ?? null;

    const allowEndpointOverride = optionOrEnv(
      options,
      env,
      "allowEndpointOverride",
      parseBoolean,
      false,
    );
    const oauthUrl = optionOrEnv(
      options,
      env,
      "oauthUrl",
      String,
      defaults.oauthUrl,
    );
    const redditUrl = optionOrEnv(
      options,
      env,
      "redditUrl",
      String,
      defaults.redditUrl,
    );
    if (
      !allowEndpointOverride &&
      (oauthUrl !== defaults.oauthUrl || redditUrl !== defaults.redditUrl)
    ) {
      throw new ClientError(
        "Custom Reddit endpoints require allowEndpointOverride: true or TRAW_ALLOW_ENDPOINT_OVERRIDE=true.",
      );
    }
    this.oauthUrl = endpoint(oauthUrl, "oauthUrl");
    this.redditUrl = endpoint(redditUrl, "redditUrl");

    this.#shortUrl = optionOrEnv(
      options,
      env,
      "shortUrl",
      String,
      defaults.shortUrl,
    );
    this.ratelimitSeconds = parsePositiveNumber(
      optionOrEnv(
        options,
        env,
        "ratelimitSeconds",
        parsePositiveNumber,
        defaults.ratelimitSeconds,
      ),
      "ratelimitSeconds",
    );
    this.timeout = parsePositiveNumber(
      optionOrEnv(
        options,
        env,
        "timeout",
        parsePositiveNumber,
        defaults.timeout,
      ),
      "timeout",
    );
    this.windowSize = parsePositiveNumber(
      optionOrEnv(
        options,
        env,
        "windowSize",
        parsePositiveNumber,
        defaults.windowSize,
      ),
      "windowSize",
    );
    this.checkForAsync = optionOrEnv(
      options,
      env,
      "checkForAsync",
      parseBoolean,
      defaults.checkForAsync,
    );
    this.checkForUpdates = optionOrEnv(
      options,
      env,
      "checkForUpdates",
      parseBoolean,
      defaults.checkForUpdates,
    );
    this.kinds = {
      comment: defaults.commentKind,
      message: defaults.messageKind,
      redditor: defaults.redditorKind,
      submission: defaults.submissionKind,
      subreddit: defaults.subredditKind,
      trophy: defaults.trophyKind,
    };
  }

  get shortUrl(): string {
    if (this.#shortUrl === null)
      throw new ClientError("No short domain specified.");
    return this.#shortUrl;
  }
}
