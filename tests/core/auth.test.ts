import { describe, expect, it, vi } from "vitest";

import { Config } from "../../src/config.js";
import { Auth, Authenticator, Authorizer } from "../../src/core/auth.js";
import type { Clock } from "../../src/core/clock.js";
import { RateLimiter } from "../../src/core/rate-limiter.js";
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from "../../src/core/transport.js";
import {
  BadJSON,
  InvalidImplicitAuth,
  InvalidInvocation,
  OAuthException,
  RequestException,
  ResponseException,
} from "../../src/exceptions.js";

function response(value: unknown, status = 200): TransportResponse {
  const body = JSON.stringify(value);
  return {
    body,
    headers: {},
    json: () => JSON.parse(body) as unknown,
    status,
    statusText: "",
    text: () => body,
    url: "https://www.reddit.com/api/v1/access_token",
  };
}

function config(
  options: {
    trusted?: boolean;
    refreshToken?: string;
    username?: string;
    password?: string;
    redirectUri?: string | null;
  } = {},
): Config {
  return new Config(
    {
      allowEndpointOverride: true,
      clientId: "client-id",
      clientSecret: options.trusted === false ? null : "client-secret",
      oauthUrl: "https://oauth.example.com",
      ...(options.password === undefined ? {} : { password: options.password }),
      redditUrl: "https://www.example.com",
      redirectUri:
        options.redirectUri === undefined
          ? "https://app.example.com/callback"
          : options.redirectUri,
      ...(options.refreshToken === undefined
        ? {}
        : { refreshToken: options.refreshToken }),
      userAgent: "traw tests",
      ...(options.username === undefined ? {} : { username: options.username }),
    },
    {},
  );
}

function setup(options: Parameters<typeof config>[0] = {}): {
  authenticator: Authenticator;
  clock: Clock & { value: number };
  send: ReturnType<
    typeof vi.fn<(request: TransportRequest) => Promise<TransportResponse>>
  >;
  transport: Transport;
} {
  const send =
    vi.fn<(request: TransportRequest) => Promise<TransportResponse>>();
  const transport: Transport = { send };
  const clock = {
    now: () => clock.value,
    sleep: vi.fn(async () => undefined),
    value: 1_000,
  };
  return {
    authenticator: new Authenticator({ config: config(options), transport }),
    clock,
    send,
    transport,
  };
}

function token(
  accessToken = "access",
  extra: Record<string, unknown> = {},
): TransportResponse {
  return response({
    access_token: accessToken,
    expires_in: 3600,
    scope: "read identity",
    ...extra,
  });
}

function form(request: TransportRequest): URLSearchParams {
  return request.body!.create() as URLSearchParams;
}

describe("Authenticator", () => {
  it("uses trusted and untrusted basic credentials without placing secrets in the form", async () => {
    for (const trusted of [true, false]) {
      const { authenticator, send } = setup({ trusted });
      send.mockResolvedValueOnce(token());
      await authenticator.requestToken({ grant_type: "client_credentials" });
      const request = send.mock.calls[0]![0];
      expect(request.headers?.["Authorization"]).toBe(
        `Basic ${Buffer.from(`client-id:${trusted ? "client-secret" : ""}`).toString("base64")}`,
      );
      expect(form(request).has("client_secret")).toBe(false);
    }
  });

  it("builds code and installed-app implicit authorization URLs", () => {
    const trusted = setup().authenticator.authorizationUrl({
      scopes: ["read", "identity"],
      state: "state",
    });
    expect(Object.fromEntries(new URL(trusted).searchParams)).toMatchObject({
      duration: "permanent",
      response_type: "code",
      scope: "read identity",
      state: "state",
    });
    const installed = setup({ trusted: false }).authenticator.authorizationUrl({
      duration: "temporary",
      implicit: true,
      scopes: ["read"],
      state: "state",
    });
    expect(new URL(installed).searchParams.get("response_type")).toBe("token");
  });

  it("does not expose credentials or password forms through transport errors", async () => {
    const { authenticator, send } = setup();
    send.mockRejectedValueOnce(
      new RequestException(new Error("offline"), {
        body: "password=super-secret",
        headers: { Authorization: "Basic secret" },
      }),
    );
    const error = await authenticator
      .requestToken({ password: "super-secret" })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RequestException);
    expect(JSON.stringify(error)).not.toContain("super-secret");
    expect(JSON.stringify(error)).not.toContain("client-secret");
  });

  it("raises OAuth errors returned with a successful HTTP status", async () => {
    const { authenticator, send } = setup();
    send.mockResolvedValueOnce(
      response({
        error: "invalid_grant",
        error_description: "bad code authorization-code",
      }),
    );
    const error = await authenticator
      .requestToken({
        code: "authorization-code",
        grant_type: "authorization_code",
      })
      .catch((value: unknown) => value);
    expect(error).toEqual(
      expect.objectContaining<Partial<OAuthException>>({
        description: "bad code [redacted]",
        error: "invalid_grant",
      }),
    );
    expect(JSON.stringify(error)).not.toContain("authorization-code");
  });

  it("supports aliases and rejects invalid authorization URL states", () => {
    const authenticator = setup().authenticator;
    expect(
      authenticator.authorizeUrl({
        duration: "temporary",
        scopes: [],
        state: "s",
      }),
    ).toBe(
      authenticator.authorizationUrl({
        duration: "temporary",
        scopes: [],
        state: "s",
      }),
    );
    expect(() =>
      setup({ redirectUri: null }).authenticator.authorizationUrl({
        scopes: [],
        state: "s",
      }),
    ).toThrow("redirect URI not provided");
    expect(() =>
      authenticator.authorizationUrl({
        implicit: true,
        scopes: [],
        state: "s",
      }),
    ).toThrow("Only installed applications can use the implicit grant flow");
    expect(() =>
      setup({ trusted: false }).authenticator.authorizationUrl({
        implicit: true,
        scopes: [],
        state: "s",
      }),
    ).toThrow("only supports temporary access tokens");
  });

  it.each([
    undefined,
    null,
    [],
    { access_token: 1, expires_in: 1, scope: "read" },
    { access_token: "a", expires_in: "1", scope: "read" },
    { access_token: "a", expires_in: Number.POSITIVE_INFINITY, scope: "read" },
    { access_token: "a", expires_in: -1, scope: "read" },
    { access_token: "a", expires_in: 1, scope: [] },
    { access_token: "a", expires_in: 1, refresh_token: 3, scope: "read" },
  ])("rejects malformed token payload %#", async (payload) => {
    const { authenticator, send } = setup();
    send.mockResolvedValueOnce(response(payload));
    await expect(authenticator.requestToken({})).rejects.toBeInstanceOf(
      BadJSON,
    );
  });

  it("converts JSON parsing failures to BadJSON", async () => {
    const { authenticator, send } = setup();
    send.mockResolvedValueOnce({
      ...response({}),
      json: () => {
        throw new SyntaxError("bad");
      },
    });
    await expect(authenticator.requestToken({})).rejects.toBeInstanceOf(
      BadJSON,
    );
  });

  it("redacts secrets from HTTP and non-Request transport failures", async () => {
    const { authenticator, send } = setup();
    const basic = Buffer.from("client-id:client-secret").toString("base64");
    send.mockResolvedValueOnce({
      ...response({}, 503),
      body: `client-secret ${basic} refresh-value`,
      json: () => ({}),
      text: () => `client-secret ${basic} refresh-value`,
    });
    const httpError = await authenticator
      .requestToken({ refresh_token: "refresh-value" })
      .catch((value: unknown) => value);
    expect(httpError).toBeInstanceOf(ResponseException);
    expect(JSON.stringify(httpError)).not.toMatch(
      /client-secret|refresh-value/,
    );
    const sanitized = (httpError as ResponseException).response;
    expect(sanitized.text?.()).toBe("[redacted] [redacted] [redacted]");
    expect(() => sanitized.json?.()).toThrow(SyntaxError);

    send.mockRejectedValueOnce(
      new Error("failed with code-value and client-secret"),
    );
    const requestError = await authenticator
      .requestToken({ code: "code-value" })
      .catch((value: unknown) => value);
    expect(requestError).toBeInstanceOf(RequestException);
    expect(String(requestError)).not.toMatch(/code-value|client-secret/);
  });

  it("passes signals, preserves abort reasons, and revokes without a hint", async () => {
    const { authenticator, send } = setup();
    const reason = new Error("cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    send.mockRejectedValueOnce(new Error("transport abort"));
    await expect(
      authenticator.requestToken({}, controller.signal),
    ).rejects.toBe(reason);

    send.mockResolvedValueOnce(response({}));
    await authenticator.revokeToken("token");
    expect(Object.fromEntries(form(send.mock.calls[1]![0]))).toEqual({
      token: "token",
    });
    expect(send.mock.calls[1]![0].url).toContain("/api/v1/revoke_token");
  });
});

describe("Authorizer", () => {
  it("requests trusted client credentials and installed-app device credentials", async () => {
    const trusted = setup();
    trusted.send.mockResolvedValueOnce(token());
    await Authorizer.readOnly({
      authenticator: trusted.authenticator,
      scopes: ["read"],
    }).headers();
    expect(Object.fromEntries(form(trusted.send.mock.calls[0]![0]))).toEqual({
      grant_type: "client_credentials",
      scope: "read",
    });

    const installed = setup({ trusted: false });
    installed.send.mockResolvedValueOnce(token());
    await Authorizer.readOnly({
      authenticator: installed.authenticator,
    }).headers();
    expect(Object.fromEntries(form(installed.send.mock.calls[0]![0]))).toEqual({
      device_id: "DO_NOT_TRACK_THIS_DEVICE",
      grant_type: "https://oauth.reddit.com/grants/installed_client",
    });
  });

  it("supports script password and refresh-token grants", async () => {
    const script = setup();
    script.send.mockResolvedValueOnce(token());
    await Authorizer.script({
      authenticator: script.authenticator,
      password: "password",
      username: "username",
    }).headers();
    expect(
      Object.fromEntries(form(script.send.mock.calls[0]![0])),
    ).toMatchObject({
      grant_type: "password",
      password: "password",
      username: "username",
    });

    const refresh = setup({ trusted: false });
    refresh.send.mockResolvedValueOnce(token());
    const authorizer = new Authorizer({
      authenticator: refresh.authenticator,
      refreshToken: "refresh",
    });
    await authorizer.headers();
    expect(Object.fromEntries(form(refresh.send.mock.calls[0]![0]))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh",
    });
  });

  it("exchanges authorization codes and installs returned refresh tokens", async () => {
    const { authenticator, send } = setup();
    send.mockResolvedValueOnce(
      token("web-access", { refresh_token: "web-refresh" }),
    );
    const authorizer = new Authorizer({ authenticator });
    await expect(authorizer.authorize("code")).resolves.toBe("web-refresh");
    expect(Object.fromEntries(form(send.mock.calls[0]![0]))).toMatchObject({
      code: "code",
      grant_type: "authorization_code",
      redirect_uri: "https://app.example.com/callback",
    });
  });

  it("tracks expiry and performs only one concurrent refresh", async () => {
    const { authenticator, clock, send } = setup();
    let resolve!: (value: TransportResponse) => void;
    send.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const authorizer = Authorizer.readOnly({ authenticator, clock });
    const first = authorizer.headers();
    const second = authorizer.headers();
    expect(send).toHaveBeenCalledOnce();
    clock.value = 9_000;
    resolve(token("shared"));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { Authorization: "bearer shared" },
      { Authorization: "bearer shared" },
    ]);
    expect(authorizer.isValid()).toBe(true);
    expect(authorizer.expiresAt).toBe(3_611_000);
    clock.value = authorizer.expiresAt!;
    expect(authorizer.isValid()).toBe(false);
  });

  it("installs implicit tokens only for untrusted applications", async () => {
    const installed = setup({ trusted: false });
    const implicit = Authorizer.implicit({
      accessToken: "implicit",
      authenticator: installed.authenticator,
      clock: installed.clock,
      expiresIn: 10,
      scope: "read identity",
    });
    await expect(implicit.headers()).resolves.toEqual({
      Authorization: "bearer implicit",
    });
    expect(implicit.scopes).toEqual(new Set(["read", "identity"]));
    expect(implicit.expiresAt).toBe(11_000);
    expect(implicit.canRefresh()).toBe(false);
    expect(() =>
      Authorizer.implicit({
        accessToken: "bad",
        authenticator: setup().authenticator,
        expiresIn: 10,
        scope: "read",
      }),
    ).toThrow(InvalidImplicitAuth);
  });

  it("revokes refresh tokens by default and access tokens on request", async () => {
    const refresh = setup();
    refresh.send.mockResolvedValue(response({}));
    const authorizer = new Authorizer({
      authenticator: refresh.authenticator,
      refreshToken: "refresh",
    });
    await authorizer.revoke();
    expect(Object.fromEntries(form(refresh.send.mock.calls[0]![0]))).toEqual({
      token: "refresh",
      token_type_hint: "refresh_token",
    });
    await expect(
      authorizer.revoke({ onlyAccess: true }),
    ).rejects.toBeInstanceOf(InvalidInvocation);
  });

  it("includes optional scopes and custom device IDs for every grant", async () => {
    const script = setup();
    script.send.mockResolvedValueOnce(token());
    await Authorizer.script({
      authenticator: script.authenticator,
      password: "password",
      scopes: ["read", "write"],
      username: "username",
    }).headers();
    expect(form(script.send.mock.calls[0]![0]).get("scope")).toBe("read write");

    const installed = setup({ trusted: false });
    installed.send.mockResolvedValueOnce(token());
    await Authorizer.readOnly({
      authenticator: installed.authenticator,
      deviceId: "device",
      scopes: ["read"],
    }).headers();
    expect(
      Object.fromEntries(form(installed.send.mock.calls[0]![0])),
    ).toMatchObject({
      device_id: "device",
      scope: "read",
    });
  });

  it("rejects grants incompatible with app type or missing refresh state", async () => {
    const installed = setup({ trusted: false }).authenticator;
    expect(() =>
      Authorizer.script({
        authenticator: installed,
        password: "p",
        username: "u",
      }),
    ).toThrow("requires a trusted application");
    expect(
      () =>
        new Authorizer({
          authenticator: installed,
          grant: { scopes: [], type: "clientCredentials" },
        }),
    ).toThrow("requires a trusted application");
    await expect(
      new Authorizer({ authenticator: installed }).refresh(),
    ).rejects.toThrow("refresh token not provided");

    const implicit = Authorizer.implicit({
      accessToken: "token",
      authenticator: installed,
      expiresIn: 0,
      scope: "",
    });
    await expect(implicit.refresh()).rejects.toThrow(
      "implicit authorization cannot be refreshed",
    );
  });

  it("requires redirect configuration when exchanging codes", async () => {
    const authenticator = setup({ redirectUri: null }).authenticator;
    await expect(
      new Authorizer({ authenticator }).authorize("code"),
    ).rejects.toThrow("redirect URI not provided");
  });

  it("invalidates and revokes installed access tokens", async () => {
    const result = setup({ trusted: false });
    result.send.mockResolvedValueOnce(token("access"));
    const authorizer = Authorizer.readOnly({
      authenticator: result.authenticator,
      clock: result.clock,
    });
    await authorizer.headers();
    authorizer.invalidate();
    expect(authorizer.isValid()).toBe(false);
    result.send
      .mockResolvedValueOnce(token("replacement"))
      .mockResolvedValueOnce(response({}));
    await authorizer.headers();
    await authorizer.revoke({ onlyAccess: true });
    expect(Object.fromEntries(form(result.send.mock.calls[2]![0]))).toEqual({
      token: "replacement",
      token_type_hint: "access_token",
    });
    expect(authorizer.accessToken).toBeNull();
  });
});

describe("Auth", () => {
  it("exposes the active session rate limits", () => {
    const auth = new Auth({
      config: config(),
      transport: setup().transport,
    });
    expect(auth.limits).toEqual({ remaining: undefined, used: undefined });
    const limiter = new RateLimiter();
    limiter.update({
      "x-ratelimit-remaining": "99",
      "x-ratelimit-reset": "60",
      "x-ratelimit-used": "1",
    });
    auth.bindRateLimiter(limiter);
    expect(auth.limits).toEqual({ remaining: 99, used: 1 });
  });
  it("selects configured grants and exposes facade operations", async () => {
    const setupResult = setup({ password: "password", username: "username" });
    setupResult.send.mockResolvedValueOnce(token());
    const auth = new Auth({
      clock: setupResult.clock,
      config: config({ password: "password", username: "username" }),
      transport: setupResult.transport,
    });
    expect(auth.readOnly).toBe(false);
    await expect(auth.scopes()).resolves.toEqual(new Set(["read", "identity"]));
    auth.readOnly = true;
    expect(auth.readOnly).toBe(true);
  });

  it("installs code and implicit authorizations", async () => {
    const web = setup();
    web.send.mockResolvedValueOnce(
      token("access", { refresh_token: "refresh" }),
    );
    const auth = new Auth({ config: config(), transport: web.transport });
    await expect(auth.authorize("code")).resolves.toBe("refresh");

    const installed = setup({ trusted: false });
    const installedAuth = new Auth({
      clock: installed.clock,
      config: config({ trusted: false }),
      transport: installed.transport,
    });
    installedAuth.implicit({
      accessToken: "implicit",
      expiresIn: 60,
      scope: "read",
    });
    await expect(installedAuth.headers()).resolves.toEqual({
      Authorization: "bearer implicit",
    });
  });

  it("selects configured refresh tokens and switches read-only through aliases", async () => {
    const result = setup({ refreshToken: "configured", trusted: false });
    result.send.mockResolvedValueOnce(token());
    const auth = new Auth({
      config: config({ refreshToken: "configured", trusted: false }),
      transport: result.transport,
    });
    expect(auth.readOnly).toBe(false);
    expect(auth.canRefresh()).toBe(true);
    auth.setReadOnly(true);
    expect(auth.authorizer).toBe(auth.readOnlyAuthorizer);
    auth.setReadOnly(false);
    await auth.headers();
    expect(form(result.send.mock.calls[0]![0]).get("refresh_token")).toBe(
      "configured",
    );
    auth.invalidate();
  });

  it("reports refresh capability for the active authorizer", () => {
    const result = setup({ trusted: false });
    const auth = new Auth({
      clock: result.clock,
      config: config({ trusted: false }),
      transport: result.transport,
    });
    expect(auth.canRefresh()).toBe(true);
    auth.implicit({ accessToken: "implicit", expiresIn: 60, scope: "read" });
    expect(auth.canRefresh()).toBe(false);
    auth.readOnly = true;
    expect(auth.canRefresh()).toBe(true);
  });

  it("rejects unavailable facade authorization modes", () => {
    const plain = new Auth({
      config: config({ trusted: false }),
      transport: setup({ trusted: false }).transport,
    });
    expect(() => {
      plain.readOnly = false;
    }).toThrow("no user authorization is available");

    const trusted = new Auth({
      config: config(),
      transport: setup().transport,
    });
    expect(() =>
      trusted.implicit({ accessToken: "a", expiresIn: 1, scope: "read" }),
    ).toThrow(InvalidImplicitAuth);
    expect(() =>
      trusted.authorizationUrl({ implicit: true, scopes: [], state: "s" }),
    ).toThrow(InvalidImplicitAuth);
  });

  it("forces temporary implicit URLs and exposes URL and scope aliases", async () => {
    const result = setup({ trusted: false });
    const auth = new Auth({
      clock: result.clock,
      config: config({ trusted: false }),
      transport: result.transport,
    });
    const url = auth.url({
      duration: "permanent",
      implicit: true,
      scopes: ["read"],
      state: "s",
    });
    expect(new URL(url).searchParams.get("duration")).toBe("temporary");
    auth.implicit({
      accessToken: "a",
      expiresIn: 10,
      scope: "read read identity",
    });
    await expect(auth.grantedScopes()).resolves.toEqual(
      new Set(["read", "identity"]),
    );
  });

  it("delegates access-token revocation", async () => {
    const result = setup({ trusted: false });
    result.send.mockResolvedValueOnce(response({}));
    const auth = new Auth({
      clock: result.clock,
      config: config({ trusted: false }),
      transport: result.transport,
    });
    auth.implicit({ accessToken: "a", expiresIn: 10, scope: "read" });
    await auth.revoke({ onlyAccess: true });
    expect(auth.authorizer.accessToken).toBeNull();
  });
});
