# Reddit Client Runtime

**Status:** Implemented

## Overview

The runtime turns a `Reddit` request into an authenticated, rate-aware HTTP
exchange. It owns configuration, OAuth grants and token refresh, replayable
request serialization, retries, response parsing, and client shutdown.

## Scope and ownership

- Owns `Config`, `Reddit`, `Auth`/`Authorizer`, `Session`, `RateLimiter`, retry
  policy, transport contracts, and HTTP exception mapping.
- Does not own endpoint-specific response schemas, model hydration, or domain
  authorization beyond selecting read-only versus user authorization.
- Runs in-process on Node.js 22+ as ESM; `FetchTransport` uses native `fetch`
  unless a transport is injected.

## Interfaces and contracts

### Construction

`Reddit` accepts one options object. Callers provide either a validated `Config`
or `clientId`, an explicit `clientSecret` (a string or `null`), and `userAgent`.
The same object accepts an optional clock, header provider, and transport for
testing and custom integrations.

Configuration may come from constructor options or `TRAW_*` environment
variables. Reddit and OAuth base URLs must use HTTPS. Non-default endpoint URLs
require `allowEndpointOverride` to prevent accidental credential disclosure.

### Request boundary

`Reddit.request()` returns decoded raw JSON, text, or `null`; verb helpers
objectify recognized Reddit things. Query values may repeat for arrays,
`null`/`undefined` facade parameters are omitted, and `raw_json=1` is added
unless disabled.

Form and object JSON requests add `api_type=json`; callers cannot supply both
`data` and `json`. A `ReplayableBody` must create a fresh equivalent body for
each send. `AbortSignal` is propagated through token acquisition, policy waits,
transport, listings, and facade-level POST rate-limit waits.

### OAuth

Supported grant behavior includes authorization-code exchange, refresh token,
trusted script credentials, trusted client credentials, installed-client device
ID, and installed-app implicit authorization. The active authorizer refreshes
before an expired token is used; concurrent refresh callers share one in-flight
refresh promise.

`readOnly` selects the application authorization. It can be disabled only when
user authorization exists or an injected provider supports the transition.
Domain mutations may additionally reject read-only use before sending a request.

## Runtime behavior

For each session attempt:

1. Wait according to retry policy.
2. Delay until the rate limiter permits a request.
3. obtain OAuth headers unless `auth: false`;
4. create a fresh body and send through the transport;
5. update rate-limit state from response headers;
6. invalidate authorization after an authenticated `401` and retry when refresh
   is possible;
7. retry eligible transport failures and `408`, `500`, `502`, `503`, `504`,
   `520`, or `522` responses;
8. parse success or raise the mapped exception.

The default session has three attempts. Attempt two has 0–2 seconds of jitter;
later attempts have 2–4 seconds. The rate limiter derives the next send time
from Reddit's `x-ratelimit-*` headers and falls back to decrementing known local
counters when those headers disappear.

Objectified POST calls have an additional bounded policy for Reddit JSON
`RATELIMIT` errors: recognizable waits at or below `ratelimitSeconds` are
retried, with one second added. This policy is POST-only and allows at most
three sends. It is separate from transport/HTTP retries.

`close()` is idempotent, invokes an optional transport close hook once, and
rejects later requests. `FetchTransport` itself has no persistent resource to
close.

## Errors and recovery

- Invalid configuration and request combinations fail before network I/O.
- Transport and timeout failures become `RequestError`; caller cancellation
  preserves the abort reason.
- HTTP statuses map to PRAW/prawcore-style response exceptions. Invalid success
  JSON becomes `BadJsonError`.
- OAuth token payload and error failures become `BadJsonError`, `OAuthError`,
  `RequestError`, or `ResponseError` as appropriate.
- Reddit JSON error tuples become `RedditApiError` during objectification.
- Retry exhaustion exposes the final eligible failure; there is no durable queue
  or automatic recovery after process exit.

## Security and privacy

- OAuth requests use Basic credentials and redact client secrets, credentials,
  codes, passwords, refresh tokens, and revoked tokens from wrapped OAuth
  failures.
- OAuth bearer tokens and credentials are held only in memory; persistence and
  rotation belong to the application.
- `auth: false` suppresses injected OAuth headers and is required for external
  media lease targets.
- Injected transports and endpoint overrides are privileged boundaries; callers
  must preserve HTTPS and avoid logging headers/bodies containing secrets.

## Key decisions

- **Replayable bodies instead of arbitrary streams:** enables safe retries, at
  the cost of buffering request payloads.
- **Injected clock/transport/header provider:** makes retry, auth, and rate
  policy deterministic in tests, but expands the trusted integration surface.
- **Explicit close state:** prevents accidental reuse even though the default
  fetch transport needs no teardown.

## Test ownership

- `tests/config.test.ts` — configuration and endpoint safeguards.
- `tests/core/auth.test.ts` — grant behavior, refresh, redaction, and read-only
  transitions.
- `tests/core/session.test.ts`, `retry.test.ts`, and `rate-limiter.test.ts` —
  dispatch, retry, status mapping, and scheduling.
- `tests/core/fetch-transport.test.ts` and `transport.test.ts` — timeout,
  cancellation, and replayable bodies.
- `tests/reddit.test.ts` — facade wiring, POST rate-limit behavior, and
  shutdown.

## Related docs

- [Architecture](../ARCHITECTURE.md)
- [Compatibility](../COMPATIBILITY.md)
- [Media and submission](media-and-submission.md)
