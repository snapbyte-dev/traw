import { describe, expect, it } from "vitest";

import { Config } from "../src/config.js";
import {
  ClientException,
  MissingRequiredAttributeException,
} from "../src/exceptions.js";

const credentials = {
  clientId: "option-id",
  clientSecret: "option-secret",
  userAgent: "traw tests",
} as const;

describe("Config", () => {
  it("uses constructor options before environment values and defaults last", () => {
    const config = new Config(
      {
        ...credentials,
        checkForAsync: false,
        clientId: "from-option",
        timeout: 12,
        username: null,
      },
      {
        TRAW_CHECK_FOR_ASYNC: "true",
        TRAW_CLIENT_ID: "from-env",
        TRAW_CLIENT_SECRET: "from-env-secret",
        TRAW_TIMEOUT: "30",
        TRAW_USER_AGENT: "from env",
        TRAW_USERNAME: "environment-user",
      },
    );

    expect(config).toMatchObject({
      checkForAsync: false,
      checkForUpdates: true,
      clientId: "from-option",
      clientSecret: "option-secret",
      oauthUrl: "https://oauth.reddit.com",
      password: null,
      ratelimitSeconds: 5,
      redditUrl: "https://www.reddit.com",
      redirectUri: null,
      refreshToken: null,
      timeout: 12,
      userAgent: "traw tests",
      username: null,
      windowSize: 600,
    });
    expect(config.shortUrl).toBe("https://redd.it");
    expect(config.kinds).toEqual({
      comment: "t1",
      message: "t4",
      redditor: "t2",
      submission: "t3",
      subreddit: "t5",
      trophy: "t6",
    });
  });

  it("reads every configurable value from its TRAW environment name", () => {
    const config = new Config(
      {},
      {
        TRAW_ALLOW_ENDPOINT_OVERRIDE: "yes",
        TRAW_CHECK_FOR_ASYNC: "off",
        TRAW_CHECK_FOR_UPDATES: "1",
        TRAW_CLIENT_ID: "env-id",
        TRAW_CLIENT_SECRET: "env-secret",
        TRAW_OAUTH_URL: "https://oauth.example/",
        TRAW_PASSWORD: "password",
        TRAW_RATELIMIT_SECONDS: "2.5",
        TRAW_REDDIT_URL: "https://reddit.example/",
        TRAW_REDIRECT_URI: "https://app.example/callback",
        TRAW_REFRESH_TOKEN: "token",
        TRAW_SHORT_URL: "https://short.example",
        TRAW_TIMEOUT: "30",
        TRAW_USER_AGENT: "env-agent",
        TRAW_USERNAME: "name",
        TRAW_WINDOW_SIZE: "900",
      },
    );

    expect(config).toMatchObject({
      checkForAsync: false,
      checkForUpdates: true,
      clientId: "env-id",
      clientSecret: "env-secret",
      oauthUrl: "https://oauth.example",
      password: "password",
      ratelimitSeconds: 2.5,
      redditUrl: "https://reddit.example",
      redirectUri: "https://app.example/callback",
      refreshToken: "token",
      timeout: 30,
      username: "name",
      windowSize: 900,
    });
    expect(config.shortUrl).toBe("https://short.example");
  });

  it.each(["1", "true", "TRUE", "yes", "on"])("parses %s as true", (value) => {
    expect(
      new Config(credentials, { TRAW_CHECK_FOR_ASYNC: value }).checkForAsync,
    ).toBe(true);
  });

  it.each(["0", "false", "FALSE", "no", "off"])(
    "parses %s as false",
    (value) => {
      expect(
        new Config(credentials, { TRAW_CHECK_FOR_UPDATES: value })
          .checkForUpdates,
      ).toBe(false);
    },
  );

  it("rejects invalid booleans and non-positive or non-finite environment numbers", () => {
    expect(
      () => new Config(credentials, { TRAW_CHECK_FOR_ASYNC: "sometimes" }),
    ).toThrow("TRAW_CHECK_FOR_ASYNC must be a boolean");
    for (const [name, value] of [
      ["TRAW_TIMEOUT", "0"],
      ["TRAW_WINDOW_SIZE", "-1"],
      ["TRAW_RATELIMIT_SECONDS", "Infinity"],
      ["TRAW_TIMEOUT", "not-a-number"],
    ] as const) {
      expect(() => new Config(credentials, { [name]: value })).toThrow(
        `${name} must be a positive number`,
      );
    }
  });

  it.each([
    ["timeout", 0],
    ["windowSize", -1],
    ["ratelimitSeconds", Number.POSITIVE_INFINITY],
    ["timeout", Number.NaN],
  ] as const)("validates the %s constructor option", (name, value) => {
    expect(() => new Config({ ...credentials, [name]: value }, {})).toThrow(
      `${name} must be a positive number`,
    );
  });

  it("treats empty environment values as absent", () => {
    const config = new Config(credentials, {
      TRAW_PASSWORD: "",
      TRAW_SHORT_URL: "",
      TRAW_TIMEOUT: "",
    });
    expect(config.password).toBeNull();
    expect(config.shortUrl).toBe("https://redd.it");
    expect(config.timeout).toBe(16);
  });

  it("requires non-blank clientId and userAgent and an explicit clientSecret decision", () => {
    expect(
      () => new Config({ clientSecret: "secret", userAgent: "agent" }, {}),
    ).toThrow(/'clientId' missing/);
    expect(
      () => new Config({ clientId: "id", clientSecret: "secret" }, {}),
    ).toThrow(/'userAgent' missing/);
    expect(
      () =>
        new Config(
          { clientId: " ", clientSecret: "secret", userAgent: "agent" },
          {},
        ),
    ).toThrow(MissingRequiredAttributeException);
    expect(
      () => new Config({ clientId: "id", userAgent: "agent" }, {}),
    ).toThrow(/explicitly set to null/);
    expect(() => new Config({ ...credentials, clientSecret: " " }, {})).toThrow(
      "Configuration setting 'clientSecret' cannot be empty.",
    );
  });

  it("accepts explicit null only as an installed-app client secret", () => {
    const config = new Config(
      { clientId: "id", clientSecret: null, userAgent: "agent" },
      {},
    );
    expect(config.clientSecret).toBeNull();
  });

  it("fails closed for both endpoint overrides, including environment overrides", () => {
    expect(
      () =>
        new Config({ ...credentials, redditUrl: "https://proxy.example" }, {}),
    ).toThrow(ClientException);
    expect(
      () =>
        new Config({ ...credentials, oauthUrl: "https://oauth.example" }, {}),
    ).toThrow(/allowEndpointOverride/);
    expect(
      () =>
        new Config(credentials, { TRAW_REDDIT_URL: "https://proxy.example" }),
    ).toThrow(/TRAW_ALLOW_ENDPOINT_OVERRIDE=true/);

    const config = new Config(
      {
        ...credentials,
        oauthUrl: "https://oauth.example/",
        allowEndpointOverride: true,
      },
      {},
    );
    expect(config.oauthUrl).toBe("https://oauth.example");
  });

  it.each([
    ["relative/path", "must be an absolute URL"],
    ["http://reddit.example", "must use HTTPS"],
  ])("rejects invalid custom endpoint %s", (redditUrl, message) => {
    expect(
      () =>
        new Config(
          { ...credentials, redditUrl, allowEndpointOverride: true },
          {},
        ),
    ).toThrow(message);
  });

  it("throws when the short domain is explicitly disabled", () => {
    const config = new Config({ ...credentials, shortUrl: null }, {});
    expect(() => config.shortUrl).toThrow("No short domain specified.");
  });
});
