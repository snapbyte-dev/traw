# TRAW Architecture

## Overview

TRAW is a Node.js 22+ ESM TypeScript client for Reddit. It is an unofficial port
of PRAW 8.0.3: compatibility is measured by observable outcomes—requests,
returned models, errors, pagination, and state transitions—not by reproducing
Python syntax.

This document is the architecture index. Component contracts and implementation
status live in [`docs/designs/`](designs/).

## Scope and boundaries

- TRAW owns configuration, OAuth, request policy, response objectification,
  models, listings, streams, media completion, and the implemented Reddit
  domains.
- Reddit owns authorization policy, endpoint behavior, response schemas,
  rate-limit headers, and media-upload leases.
- The caller owns credentials, requested OAuth scopes, cancellation, consumption
  of lazy iterables, and client shutdown.
- The PRAW 8.0.3 ledger verifies all 16 required outcome groups and every
  scenario. Outcome parity does not require Python symbol identity or identical
  API shape; the separate 85-export manifest is nonblocking. See the
  [compatibility ledger design](designs/compatibility-ledger.md).

## Principles

1. **Explicit asynchronous work.** Factories create references synchronously;
   `load()` and `refresh()` perform hydration. Listings and polling streams are
   `AsyncIterable`.
2. **Replay before retry.** Request bodies and media bytes are snapshotted so an
   eligible retry can reproduce the payload.
3. **Outcome parity with explicit adaptations.** TypeScript differences such as
   options objects, camel case, promises, and `AbortSignal` are intentional;
   behavioral claims require tests.
4. **Secure defaults.** Reddit endpoints require HTTPS, custom endpoint
   overrides require an explicit opt-in, and OAuth errors redact known secrets.

## Topology

```text
Application
    |
    v
Reddit facade and subreddit-scoped domains
    |                 |                         \
    v                 v                          v
models/listings   moderation, modmail,      media lease
and streams       wiki/assets/widgets       |
    |                 |                     +-> external upload (no OAuth)
    +-----------------+-----> Session <------+
                                |
                      OAuth + retry + rate limit
                                |
                           FetchTransport
                                |
                          Reddit OAuth API

Media submission completion: Reddit response -> WebSocket status -> Submission
```

**Active components**

- **`Reddit` facade** — wires configuration, authentication, session, transport,
  objectification, and implemented domain helpers.
- **Core runtime** — obtains OAuth headers, schedules requests against observed
  rate limits, retries eligible failures, and maps HTTP failures.
- **Models and iteration** — creates response-backed entities, hydrates
  references explicitly, and traverses generic and domain-specific listings and
  polling streams.
- **Account and content domains** — expose authenticated account state,
  relationships, content discovery, content actions, drafts, announcements,
  inbox, live threads, multireddits, and collections.
- **Moderation and modmail** — expose subreddit-scoped queues, logs,
  relationships, flair, notes, rules, removal reasons, modern modmail, and
  legacy modmail.
- **Community assets** — expose wiki pages/revisions, emoji, legacy and
  structured stylesheet assets, and typed widget snapshots and mutations.
- **Media and submission** — snapshots media, obtains Reddit upload leases,
  uploads without OAuth, builds standard or inline-rich-text submissions, and
  can follow asynchronous completion over WebSocket.
- **Compatibility controls** — pin PRAW 8.0.3 behavior, verify all required
  outcomes and scenarios, and keep the nonblocking export inventory separate
  from outcome parity.

## Shared control flow

1. The caller constructs a reference, helper, listing, or request.
2. `Session` serializes replayable input, waits for retry/rate-limit policy, and
   asks the active authorizer for OAuth headers.
3. `FetchTransport` sends the request with timeout and cancellation signals and
   buffers the response.
4. `Session` updates rate-limit state, retries eligible failures, or maps the
   response to a typed exception.
5. Higher layers objectify known Reddit things while retaining unknown fields
   through `raw` and `get()`.

Media adds separate trust boundaries. Reddit issues a submission, emoji,
stylesheet, or widget lease; TRAW sends lease fields and snapshotted bytes
directly to the lease URL without Reddit OAuth headers. Image/video submission
can then open the Reddit-provided WebSocket URL, validate the processing update,
and resolve the redirected submission.

## Runtime, security, and operations

- Runtime: Node.js 22 or newer, native ESM, native `fetch`, `AbortSignal`, Web
  APIs including WebSocket, and Node filesystem access for path-backed media.
- Deployment is library-defined, not service-defined; TRAW has no process
  manager, database, queue, or background worker.
- Credentials, privileged account/moderation data, lease fields, and media
  remain in memory. The library does not persist them.
- Request retries, media-completion waits, and individual policy waits are
  in-process and bounded; polling streams can continue until returned, aborted,
  or failed. There is no durable recovery after process exit.
- There is no built-in metrics or logging sink; callers observe failures through
  promises, exceptions, and stream error hooks.

## Design index

- [Reddit client runtime](designs/reddit-client-runtime.md)
- [Models, listings, and streams](designs/models-listings-and-streams.md)
- [Media and submission](designs/media-and-submission.md)
- [Domain capabilities](designs/domain-capabilities.md)
- [Moderation and modmail](designs/moderation-and-modmail.md)
- [Community administration](designs/community-administration.md)
- [Compatibility ledger](designs/compatibility-ledger.md)
