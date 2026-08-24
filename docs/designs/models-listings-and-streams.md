# Models, Listings, and Streams

**Status:** Implemented for the documented, locally tested boundaries

## Overview

This layer converts Reddit response shapes into client-bound objects and exposes
network collections through explicit asynchronous iteration. It avoids hidden
network I/O: a reference is cheap and synchronous, while hydration, pagination,
placeholder expansion, and polling are explicit async operations.

## Interfaces and contracts

### Models and hydration

`RedditModel` instances have stable identity, `isLoaded`, `load()`, `refresh()`,
`equals()`, `raw`, and `get()`. Constructing a comment, submission, redditor,
subreddit, or message from a string creates an unloaded reference. `load()`
fetches only when unloaded; `refresh()` always fetches and merges matched
response data.

Known entities use case-insensitive identities. `Objector` recognizes Reddit
kind wrappers (`t1`–`t5` and `more`) and selected structural shapes. Within one
objectification context, repeated authors, subreddits, submissions, and comments
reuse object identity. Unknown response fields remain available and non-reserved
fields are copied onto model instances.

`Submission.refresh()` loads the submission and recursive comment forest
together. `commentSort` and `commentLimit` must be set before loading.
`CommentForest.replaceMore()` mutates one forest, resolves largest placeholders
first, and prohibits concurrent replacement on that forest.

### Listings

`Listing<T>` is a lazy, single-use `AsyncIterable<T>`. Iteration requests pages
only as needed, honors a total `limit` (`null` means unbounded), applies a
per-request limit, objectifies children, forwards cancellation, and stops on an
empty page, absent cursor, or repeated cursor.

The standard adapter uses `after`. Specialized adapters cover announcements,
moderator notes, modern modmail conversations, wiki revisions, live
contributors, and other domain response envelopes. `InfoListing` and live-thread
info batch identities in groups of 100.

### Polling streams

`streamGenerator()` accepts a fetcher returning an iterable or async iterable
and returns `AsyncGenerator<T | null>`. It assumes fetched pages are
newest-first and yields unseen items oldest-first. A bounded least-recently-seen
set (default 301) suppresses duplicates.

The stream supports `skipExisting`, continuation IDs, custom identity
attributes, optional omission of the `before` cursor, `pauseAfter` null
sentinels, cancellation, and an error hook. Recoverable fetch errors and idle
polls use jittered exponential backoff from one to sixteen seconds. Bound
adapters exist for subreddit/redditor content, moderation queues, modern and
legacy modmail, multireddits, and live updates.

## State and runtime constraints

- Models retain response data in memory only; refresh merges fields and does not
  remove stale fields absent from a later response.
- Listings cannot be restarted or iterated twice. Create a new listing to replay
  a query.
- Streams are intentionally unbounded until returned, aborted, or failed.
- Stream deduplication is bounded; an evicted old ID can be yielded again.
- `CommentForest.replaceMore()` is destructive: skipped placeholders are removed
  and returned to the caller.

## Errors and recovery

- Malformed identities, wrappers, listing children, cursors, comment trees, or
  stream item attributes raise `TypeError`.
- Invalid limits, capacities, poll durations, and thresholds raise `RangeError`.
- A missing model in a hydration response rejects refresh rather than marking
  the object loaded.
- Without a stream `onError` hook, fetch errors terminate iteration. With a
  hook, TRAW reports the error, waits, and retries; cancellation is never routed
  through the hook.
- Network, auth, and HTTP errors pass through from the client runtime.

## Security and privacy

- Models can contain user-generated text, usernames, private messages, and
  moderation data. TRAW does not redact ordinary model data; callers control
  logging and retention.
- Unknown fields are intentionally retained for forward compatibility and may
  contain data not represented in static types.
- `AbortSignal` is the supported way to stop listings, hydration, and streams;
  abandoning an iterator does not cancel an already-started request unless its
  signal is aborted.

## Key decisions

- **Explicit hydration:** JavaScript property access cannot await, so reference
  creation never implies network I/O.
- **`AsyncIterable` for listings and streams:** supports backpressure and
  incremental pagination while adapting PRAW's synchronous iteration model.
- **Response-field retention:** reduces breakage when Reddit adds fields, at the
  cost of a broad, caller-visible data surface.
- **Single-use listings:** makes cursor state unambiguous and prevents
  accidental duplicate requests.

## Compatibility boundary

PRAW 8.0.3 is a behavioral reference, not a requirement to reproduce Python
symbols or API shapes. Focused local tests define the supported model, listing,
and stream boundaries; exported types do not independently claim behavior.

## Test ownership

- `tests/models.test.ts`, `models-edge-cases.test.ts`, and
  `model-capabilities.test.ts` — hydration, identity, object graphs, response
  containers, and comment forests.
- `tests/objector.test.ts` — kind and shape conversion and API error detection.
- `tests/listing.test.ts` and `helpers.test.ts` — cursor adapters, batching,
  limits, and listing helpers.
- `tests/stream.test.ts` — ordering, deduplication, pause behavior, retries, and
  cancellation.
- `tests/types/public-api.ts` — compile-time public contracts.

## Related docs

- [Architecture](../ARCHITECTURE.md)
- [Domain capabilities](domain-capabilities.md)
- [Compatibility](../COMPATIBILITY.md)
