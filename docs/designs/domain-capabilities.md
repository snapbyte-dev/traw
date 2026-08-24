# Domain Capabilities

**Status:** Implemented for the documented, locally tested boundaries

## Overview

Domain helpers organize endpoint workflows around the `Reddit` facade while
reusing the runtime, listing, and model contracts. This document records the
capabilities that have real request behavior today and the boundary for future
domains.

## Implemented contracts

| Surface                                    | Contract                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `front`, `subreddit(name)`, `domain(name)` | Lazy standard sorts including best/controversial where applicable; subreddit comments, search, sticky, traffic, post requirements, and content streams.                                                                                                                                                               |
| `redditor(name)`                           | Lazy overview, comment, submission, saved, hidden, upvoted, and downvoted listings plus comment/submission streams.                                                                                                                                                                                                   |
| `info()`                                   | Single-use async listing by exactly one of fullname batches, subreddit batches, or URL.                                                                                                                                                                                                                               |
| `account`                                  | Current user with cache bypass and profile subreddit objectification; karma; subscribed/contributor/moderator communities; `preferences.get()`/`update()`; friends/blocked/trusted users; profile pins; trophies; moderated communities; owned/public multireddits; relationship mutations. There is no `user` alias. |
| `inbox`                                    | Async views for all, unread, messages, replies, mentions, and sent; mark-all-read and 25-item unread batches.                                                                                                                                                                                                         |
| `announcements`                            | `announcements.list()` with specialized `after` pagination, item/batch hide and mark-read operations, and authorized mark-all-read.                                                                                                                                                                                   |
| `drafts`                                   | `drafts.reference()`, `drafts.list()`, and `drafts.create()`, plus draft hydration, update, delete, and submit for validated markdown/link drafts.                                                                                                                                                                    |
| `live`                                     | `live.reference()`, create, batch info, happening-now lookup, hydration, updates/discussions, reporting, contribution/moderation, contributor relationships, and update streams.                                                                                                                                      |
| `multireddits`                             | `reddit.multireddits.reference/load/create/mine/public`, plus model update, add/remove communities, copy, rename, delete, sorted listings, and comment/submission streams.                                                                                                                                            |
| `notes`                                    | Site-wide, subreddit-scoped, and redditor-scoped moderator-note listing, filtering, creation, deletion, and chunked bulk operations.                                                                                                                                                                                  |
| `redditors`, `subreddits`                  | New/search and default/new/popular/search discovery listings.                                                                                                                                                                                                                                                         |
| `usernameAvailable()`                      | Boolean username availability request.                                                                                                                                                                                                                                                                                |

Entity methods also implement reusable content actions: reply, edit, delete,
vote/clear vote, save/unsave, report, inbox reply toggles, moderation actions,
and submission hide/unhide, duplicates, crosspost, flair selection, visited
state, and submission-specific moderation state. Subreddits support tested
submission variants, including inline rich text; redditors support messaging and
account relationship operations.

## Interface conventions

- Helpers return a lazy model reference, promise, or single-use `AsyncIterable`;
  no property access starts hidden network work.
- Python keyword-only arguments become TypeScript options objects and public
  names use camel case.
- Strings used as path identities are trimmed, rejected when empty, and
  URL-encoded where they become path segments.
- Model values accepted as identities use their `toString()` result.
- Optional `AbortSignal` flows to every request made by the operation.
- PRAW helper objects are represented by client-bound TypeScript classes with
  named methods rather than callable objects.

## Runtime and state

Domain helpers are client-bound and in-memory. They delegate OAuth, retry, rate
limiting, serialization, and HTTP error mapping to the client runtime. Listing
helpers defer requests until iteration. `account.me()` retains the last resolved
`Redditor` unless `useCache: false` is passed; other domain snapshots document
their own loaded state.

Authorized domains and privileged resource models reject `readOnly` before
dispatch. Generic content-model mutations rely on the active authorization and
Reddit response rather than performing that local check.

## Errors and recovery

- Empty identities, mutually exclusive draft inputs, missing flair dependencies,
  malformed domain responses, and non-boolean username results fail with
  `TypeError`.
- Authorized-only domain methods fail with `ReadOnlyError` in read-only mode.
- Pagination, transport, OAuth, Reddit API, and HTTP failures preserve the
  lower-layer contracts.
- Bulk inbox unread updates are sequential batches. A failure can leave earlier
  batches applied; there is no rollback.

## Security and privacy

- Callers must request scopes appropriate to each endpoint; local authorization
  checks do not prove sufficient Reddit scopes.
- Inbox, drafts, current-user data, and moderator notes can contain private or
  sensitive content and remain in memory as returned models.
- User/domain input is encoded when inserted into paths but remains
  caller-controlled when used as query/form data.

## Compatibility boundary

PRAW 8.0.3 is the behavioral reference, while the TypeScript-native source and
focused local tests define the supported boundaries. New capabilities must:

1. expose explicit promise/`AsyncIterable` outcomes and cancellation;
2. validate inputs before network I/O;
3. preserve read-only and OAuth scope boundaries;
4. use model objectification without claiming fields Reddit does not guarantee;
5. define partial-failure behavior for batched mutations;
6. add dedicated tests and cite pinned upstream behavior where relevant.

Moderation/modmail and community administration are detailed separately because
their authorization and operational risks are broader.

## Test ownership

- `tests/account-domain.test.ts`, `standalone-*.test.ts`, and
  `public-integration.test.ts` — account and bounded helper lifecycles.
- `tests/helpers.test.ts`, `reddit.test.ts`, and `content-actions-edge.test.ts`
  — discovery, listings, streams, and content actions.
- `tests/live-domain.test.ts`, `multireddit-domain.test.ts`, and
  `collections-domain.test.ts` — full documented lifecycles and edge contracts.
- `tests/model-capabilities.test.ts`, `models-edge-cases.test.ts`, and
  `media-outcomes.test.ts` — entity mutations, submissions, inline media, and
  media completion.

## Related docs

- [Models, listings, and streams](models-listings-and-streams.md)
- [Moderation and modmail](moderation-and-modmail.md)
- [Community administration](community-administration.md)
- [Compatibility](../COMPATIBILITY.md)
