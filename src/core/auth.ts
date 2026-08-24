import { Buffer } from "node:buffer";

import { Config } from "../config.js";
import {
  BadJsonError,
  InvalidImplicitAuthError,
  InvalidInvocationError,
  OAuthError,
  RequestError,
  ResponseError,
} from "../exceptions.js";
import { systemClock, type Clock } from "./clock.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { HeaderProvider } from "./session.js";
import {
  replayableForm,
  type Transport,
  type TransportResponse,
} from "./transport.js";

const ACCESS_TOKEN_PATH = "/api/v1/access_token";
const AUTHORIZATION_PATH = "/api/v1/authorize";
const REVOKE_TOKEN_PATH = "/api/v1/revoke_token";
const INSTALLED_CLIENT_GRANT =
  "https://oauth.reddit.com/grants/installed_client";
const DEFAULT_DEVICE_ID = "DO_NOT_TRACK_THIS_DEVICE";

export type AuthDuration = "permanent" | "temporary";
export type TokenType = "access_token" | "refresh_token";

export interface AuthorizationUrlOptions {
  readonly scopes: readonly string[];
  readonly state: string;
  readonly duration?: AuthDuration;
  readonly implicit?: boolean;
}

export interface AuthenticatorOptions {
  readonly config: Config;
  readonly transport: Transport;
}

interface TokenPayload {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken?: string;
  readonly scopes: ReadonlySet<string>;
}

function parseObject(response: TransportResponse): Record<string, unknown> {
  let value: unknown;
  try {
    value = response.json();
  } catch {
    throw new BadJsonError(response);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadJsonError(response);
  }
  return value as Record<string, unknown>;
}

function parseToken(response: TransportResponse): TokenPayload {
  const value = parseObject(response);
  const accessToken = value["access_token"];
  const expiresIn = value["expires_in"];
  const scope = value["scope"];
  const refreshToken = value["refresh_token"];
  if (
    typeof accessToken !== "string" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn < 0 ||
    typeof scope !== "string" ||
    (refreshToken !== undefined && typeof refreshToken !== "string")
  ) {
    throw new BadJsonError(response);
  }
  return {
    accessToken,
    expiresIn,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    scopes: new Set(scope.split(" ").filter(Boolean)),
  };
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) =>
      secret.length === 0 ? result : result.replaceAll(secret, "[redacted]"),
    value,
  );
}

function sanitizedResponse(
  response: TransportResponse,
  secrets: readonly string[],
): TransportResponse {
  const body = redact(response.body, secrets);
  return {
    ...response,
    body,
    json: () => JSON.parse(body) as unknown,
    text: () => body,
  };
}

export class Authenticator {
  readonly config: Config;
  readonly #transport: Transport;

  constructor(options: AuthenticatorOptions) {
    this.config = options.config;
    this.#transport = options.transport;
  }

  get trusted(): boolean {
    return this.config.clientSecret !== null;
  }

  authorizationUrl(options: AuthorizationUrlOptions): string {
    if (this.config.redirectUri === null)
      throw new InvalidInvocationError("redirect URI not provided");
    const implicit = options.implicit ?? false;
    const duration = options.duration ?? "permanent";
    if (implicit && this.trusted) {
      throw new InvalidInvocationError(
        "Only installed applications can use the implicit grant flow.",
      );
    }
    if (implicit && duration !== "temporary") {
      throw new InvalidInvocationError(
        "The implicit grant flow only supports temporary access tokens.",
      );
    }
    const url = new URL(AUTHORIZATION_PATH, this.config.redditUrl);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      duration,
      redirect_uri: this.config.redirectUri,
      response_type: implicit ? "token" : "code",
      scope: options.scopes.join(" "),
      state: options.state,
    }).toString();
    return url.toString();
  }

  async requestToken(
    data: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<TokenPayload> {
    const response = await this.#post(ACCESS_TOKEN_PATH, data, signal);
    const value = parseObject(response);
    const error = value["error"];
    if (typeof error === "string") {
      const description = value["error_description"];
      const secrets = this.#secrets(data);
      throw new OAuthError(
        sanitizedResponse(response, secrets),
        redact(error, secrets),
        typeof description === "string" ? redact(description, secrets) : null,
      );
    }
    return parseToken(response);
  }

  async revokeToken(
    token: string,
    tokenType?: TokenType,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#post(
      REVOKE_TOKEN_PATH,
      {
        token,
        ...(tokenType === undefined ? {} : { token_type_hint: tokenType }),
      },
      signal,
    );
  }

  async #post(
    path: string,
    data: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<TransportResponse> {
    const url = new URL(path, this.config.redditUrl).toString();
    const secret = this.config.clientSecret ?? "";
    const secrets = this.#secrets(data);
    let response: TransportResponse;
    try {
      response = await this.#transport.send({
        body: replayableForm(
          Object.entries(data).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${secret}`).toString("base64")}`,
          Connection: "close",
          "User-Agent": this.config.userAgent,
        },
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
        url,
      });
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason ?? error;
      const original =
        error instanceof RequestError ? error.originalError : error;
      const detail =
        original instanceof Error ? original.message : String(original);
      throw new RequestError(new Error(redact(detail, secrets)), {
        method: "POST",
        url,
      });
    }
    if (response.status !== 200)
      throw new ResponseError(sanitizedResponse(response, secrets));
    return response;
  }

  #secrets(data: Readonly<Record<string, string>>): string[] {
    const secret = this.config.clientSecret ?? "";
    const basicCredentials = Buffer.from(
      `${this.config.clientId}:${secret}`,
    ).toString("base64");
    const sensitiveKeys = new Set([
      "code",
      "password",
      "refresh_token",
      "token",
    ]);
    return [
      secret,
      basicCredentials,
      ...Object.entries(data)
        .filter(([key]) => sensitiveKeys.has(key))
        .map(([, value]) => value),
    ];
  }
}

type Grant =
  | { readonly type: "authorizationCode" }
  | { readonly scopes: readonly string[]; readonly type: "clientCredentials" }
  | {
      readonly deviceId: string;
      readonly scopes: readonly string[];
      readonly type: "deviceId";
    }
  | { readonly type: "implicit" }
  | { readonly type: "refreshToken" }
  | {
      readonly password: string;
      readonly scopes: readonly string[];
      readonly type: "script";
      readonly username: string;
    };

export interface AuthorizerOptions {
  readonly authenticator: Authenticator;
  readonly clock?: Clock;
  readonly grant?: Grant;
  readonly refreshToken?: string | null;
}

export interface ScriptAuthorizationOptions {
  readonly authenticator: Authenticator;
  readonly clock?: Clock;
  readonly password: string;
  readonly scopes?: readonly string[];
  readonly username: string;
}

export interface DeviceAuthorizationOptions {
  readonly authenticator: Authenticator;
  readonly clock?: Clock;
  readonly deviceId?: string;
  readonly scopes?: readonly string[];
}

export interface ImplicitAuthorizationOptions {
  readonly accessToken: string;
  readonly authenticator: Authenticator;
  readonly clock?: Clock;
  readonly expiresIn: number;
  readonly scope: string;
}

export class Authorizer implements HeaderProvider {
  accessToken: string | null = null;
  refreshToken: string | null;
  scopes: ReadonlySet<string> | null = null;
  expiresAt: number | null = null;

  readonly authenticator: Authenticator;
  readonly #clock: Clock;
  readonly #grant: Grant;
  #refreshing: Promise<void> | null = null;

  constructor(options: AuthorizerOptions) {
    this.authenticator = options.authenticator;
    this.#clock = options.clock ?? systemClock;
    this.#grant = options.grant ?? { type: "authorizationCode" };
    this.refreshToken = options.refreshToken ?? null;
    this.#validateGrant();
  }

  static readOnly(options: DeviceAuthorizationOptions): Authorizer {
    const common = {
      authenticator: options.authenticator,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    };
    return options.authenticator.trusted
      ? new Authorizer({
          ...common,
          grant: { scopes: options.scopes ?? [], type: "clientCredentials" },
        })
      : new Authorizer({
          ...common,
          grant: {
            deviceId: options.deviceId ?? DEFAULT_DEVICE_ID,
            scopes: options.scopes ?? [],
            type: "deviceId",
          },
        });
  }

  static script(options: ScriptAuthorizationOptions): Authorizer {
    return new Authorizer({
      authenticator: options.authenticator,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      grant: {
        password: options.password,
        scopes: options.scopes ?? [],
        type: "script",
        username: options.username,
      },
    });
  }

  static implicit(options: ImplicitAuthorizationOptions): Authorizer {
    const authorizer = new Authorizer({
      authenticator: options.authenticator,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      grant: { type: "implicit" },
    });
    authorizer.#install({
      accessToken: options.accessToken,
      expiresIn: options.expiresIn,
      scopes: new Set(options.scope.split(" ").filter(Boolean)),
    });
    return authorizer;
  }

  isValid(): boolean {
    return (
      this.accessToken !== null &&
      this.expiresAt !== null &&
      this.#clock.now() < this.expiresAt
    );
  }

  canRefresh(): boolean {
    return this.#grant.type !== "implicit";
  }

  async headers(
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, string>>> {
    if (!this.isValid()) await this.refresh(signal);
    if (this.accessToken === null)
      throw new InvalidInvocationError("no access token available");
    return { Authorization: `bearer ${this.accessToken}` };
  }

  invalidate(): void {
    this.#clearAccessToken();
  }

  async authorize(code: string, signal?: AbortSignal): Promise<string | null> {
    if (this.authenticator.config.redirectUri === null) {
      throw new InvalidInvocationError("redirect URI not provided");
    }
    const requestedAt = this.#clock.now();
    const payload = await this.authenticator.requestToken(
      {
        code,
        grant_type: "authorization_code",
        redirect_uri: this.authenticator.config.redirectUri,
      },
      signal,
    );
    this.#install(payload, requestedAt, 10_000);
    return this.refreshToken;
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.#refreshing !== null) return this.#refreshing;
    this.#refreshing = this.#performRefresh(signal).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async revoke(
    options: {
      readonly onlyAccess?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    if (options.onlyAccess !== true && this.refreshToken !== null) {
      await this.authenticator.revokeToken(
        this.refreshToken,
        "refresh_token",
        options.signal,
      );
      this.refreshToken = null;
      this.#clearAccessToken();
      return;
    }
    if (this.accessToken === null)
      throw new InvalidInvocationError("no token available to revoke");
    await this.authenticator.revokeToken(
      this.accessToken,
      "access_token",
      options.signal,
    );
    this.#clearAccessToken();
  }

  async #performRefresh(signal?: AbortSignal): Promise<void> {
    let data: Record<string, string>;
    switch (this.#grant.type) {
      case "authorizationCode":
      case "refreshToken":
        if (this.refreshToken === null)
          throw new InvalidInvocationError("refresh token not provided");
        data = {
          grant_type: "refresh_token",
          refresh_token: this.refreshToken,
        };
        break;
      case "clientCredentials":
        data = { grant_type: "client_credentials" };
        if (this.#grant.scopes.length > 0)
          data["scope"] = this.#grant.scopes.join(" ");
        break;
      case "deviceId":
        data = {
          device_id: this.#grant.deviceId,
          grant_type: INSTALLED_CLIENT_GRANT,
        };
        if (this.#grant.scopes.length > 0)
          data["scope"] = this.#grant.scopes.join(" ");
        break;
      case "script":
        data = {
          grant_type: "password",
          password: this.#grant.password,
          username: this.#grant.username,
        };
        if (this.#grant.scopes.length > 0)
          data["scope"] = this.#grant.scopes.join(" ");
        break;
      case "implicit":
        throw new InvalidInvocationError(
          "implicit authorization cannot be refreshed",
        );
    }
    const requestedAt = this.#clock.now();
    this.#install(
      await this.authenticator.requestToken(data, signal),
      requestedAt,
      10_000,
    );
  }

  #install(
    payload: TokenPayload,
    requestedAt = this.#clock.now(),
    bufferMs = 0,
  ): void {
    this.accessToken = payload.accessToken;
    this.expiresAt = requestedAt + payload.expiresIn * 1_000 + bufferMs;
    this.scopes = payload.scopes;
    if (payload.refreshToken !== undefined)
      this.refreshToken = payload.refreshToken;
  }

  #clearAccessToken(): void {
    this.accessToken = null;
    this.expiresAt = null;
    this.scopes = null;
  }

  #validateGrant(): void {
    const trusted = this.authenticator.trusted;
    if (
      (this.#grant.type === "clientCredentials" ||
        this.#grant.type === "script") &&
      !trusted
    ) {
      throw new InvalidInvocationError(
        "This authorization requires a trusted application.",
      );
    }
    if (this.#grant.type === "implicit" && trusted)
      throw new InvalidImplicitAuthError();
  }
}

export interface AuthOptions {
  readonly clock?: Clock;
  readonly config: Config;
  readonly transport: Transport;
}

export class Auth implements HeaderProvider {
  readonly authenticator: Authenticator;
  readonly readOnlyAuthorizer: Authorizer;
  #activeAuthorizer: Authorizer;
  #authorizedAuthorizer: Authorizer | null = null;
  readonly #clock: Clock | undefined;
  #rateLimiter: RateLimiter | undefined;

  constructor(options: AuthOptions) {
    this.authenticator = new Authenticator({
      config: options.config,
      transport: options.transport,
    });
    this.#clock = options.clock;
    this.readOnlyAuthorizer = Authorizer.readOnly({
      authenticator: this.authenticator,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });

    if (
      this.authenticator.trusted &&
      options.config.username !== null &&
      options.config.password !== null
    ) {
      this.#authorizedAuthorizer = Authorizer.script({
        authenticator: this.authenticator,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        password: options.config.password,
        username: options.config.username,
      });
    } else if (options.config.refreshToken !== null) {
      this.#authorizedAuthorizer = new Authorizer({
        authenticator: this.authenticator,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        grant: { type: "refreshToken" },
        refreshToken: options.config.refreshToken,
      });
    }
    this.#activeAuthorizer =
      this.#authorizedAuthorizer ?? this.readOnlyAuthorizer;
  }

  get authorizer(): Authorizer {
    return this.#activeAuthorizer;
  }

  get limits(): Readonly<{
    readonly remaining: number | undefined;
    readonly used: number | undefined;
  }> {
    return {
      remaining: this.#rateLimiter?.remaining,
      used: this.#rateLimiter?.used,
    };
  }

  bindRateLimiter(rateLimiter: RateLimiter): void {
    this.#rateLimiter = rateLimiter;
  }

  get readOnly(): boolean {
    return this.#activeAuthorizer === this.readOnlyAuthorizer;
  }

  set readOnly(value: boolean) {
    if (value) {
      this.#activeAuthorizer = this.readOnlyAuthorizer;
    } else if (this.#authorizedAuthorizer !== null) {
      this.#activeAuthorizer = this.#authorizedAuthorizer;
    } else {
      throw new InvalidInvocationError(
        "readOnly cannot be unset because no user authorization is available",
      );
    }
  }

  setReadOnly(value: boolean): void {
    this.readOnly = value;
  }

  headers(signal?: AbortSignal): Promise<Readonly<Record<string, string>>> {
    return this.#activeAuthorizer.headers(signal);
  }

  canRefresh(): boolean {
    return this.#activeAuthorizer.canRefresh();
  }

  invalidate(): void {
    this.#activeAuthorizer.invalidate();
  }

  async authorize(code: string, signal?: AbortSignal): Promise<string | null> {
    const authorizer = new Authorizer({
      authenticator: this.authenticator,
      ...(this.#clock === undefined ? {} : { clock: this.#clock }),
    });
    const refreshToken = await authorizer.authorize(code, signal);
    this.#authorizedAuthorizer = authorizer;
    this.#activeAuthorizer = authorizer;
    return refreshToken;
  }

  implicit(options: {
    readonly accessToken: string;
    readonly expiresIn: number;
    readonly scope: string;
  }): void {
    if (this.authenticator.trusted) throw new InvalidImplicitAuthError();
    const authorizer = Authorizer.implicit({
      ...options,
      authenticator: this.authenticator,
      ...(this.#clock === undefined ? {} : { clock: this.#clock }),
    });
    this.#authorizedAuthorizer = authorizer;
    this.#activeAuthorizer = authorizer;
  }

  authorizationUrl(options: AuthorizationUrlOptions): string {
    const implicit = options.implicit ?? false;
    if (implicit && this.authenticator.trusted)
      throw new InvalidImplicitAuthError();
    return this.authenticator.authorizationUrl({
      ...options,
      ...(implicit ? { duration: "temporary" } : {}),
    });
  }

  async grantedScopes(signal?: AbortSignal): Promise<ReadonlySet<string>> {
    await this.#activeAuthorizer.headers(signal);
    if (this.#activeAuthorizer.scopes === null)
      throw new InvalidInvocationError("no scopes available");
    return new Set(this.#activeAuthorizer.scopes);
  }

  revoke(
    options: {
      readonly onlyAccess?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    return this.#activeAuthorizer.revoke(options);
  }
}
