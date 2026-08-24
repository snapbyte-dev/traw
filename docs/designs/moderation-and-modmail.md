# Moderation and Modmail

**Status:** Implemented; required moderation and modmail outcomes verified

## Overview

Moderation is scoped from `reddit.subreddit(name)`. The repository implements
queue/log reads and streams, community relationships, flair, scoped moderator
notes, rules, removal reasons, content moderation actions, modern modmail, and
legacy modmail. Source, focused tests, and the schema-v2 ledger verify all
required PRAW 8.0.3 moderation and modmail outcomes.

## Moderation contracts

- `subreddit.moderation` exposes edited, modqueue, reports, spam, unmoderated,
  and mod-log listings. Filters include content kind, action, and moderator;
  matching polling streams reuse the generic deduplication/backoff contract.
- `subreddit.relationships` exposes banned, muted, contributor, moderator,
  wiki-banned, and wiki-contributor reads and mutations, including moderator
  invitation/permission operations.
- `subreddit.flair`, `modNotes`, `rules`, and `removalReasons` expose the tested
  list and mutation lifecycles described in
  [Community administration](community-administration.md). Moderator notes can
  be listed, filtered, created, and deleted through site-wide, subreddit-scoped,
  and redditor-scoped views; bulk operations chunk at 500.
- `Comment.mod` and `Submission.mod` expose approve, remove (optionally with
  removal reason/mod note), typed removal messages, report-ignore, lock, and
  distinguish operations. Comment moderation can show crowd-controlled comments.
  Submission moderation additionally handles contest, sticky, suggested-sort,
  crowd-control, NSFW/spoiler, and original-content state.

## Modmail contracts

- `subreddit.modmail` fetches and lists modern conversations with
  state/sort/entity filters and ID cursors; creates conversations; lists
  participating subreddits; bulk-marks read; returns unread counts; and provides
  a polling stream.
- `ModmailConversation` preserves typed authors, participant/user, messages, and
  mod actions. It refreshes, replies, archives/unarchives,
  highlights/unhighlights, mutes/unmutes, and marks one or multiple
  conversations read/unread.
- `subreddit.legacyModmail` lists inbox/unread messages, sends to a subreddit or
  recipient, replies through `LegacyModmailMessage`, and polls unread messages.
- Modern modmail remains separate from ordinary inbox and legacy `t4` messages.

## Runtime and operational concerns

- Moderation writes must pass through the same OAuth, retry, and rate-limit
  runtime. Retrying a non-idempotent action requires evidence that repeating the
  request has equivalent observable outcomes; replayability alone is
  insufficient.
- Long-running queue consumers should compose listings with polling streams
  rather than introduce hidden background work.
- Modmail listing cursors and conversation refresh state are separate; parsers
  validate envelope maps and object order before constructing models.
- Partial failures must report completed and failed items or stop
  deterministically with documented progress.

## Errors and recovery

Read-only mutations and privileged reads fail locally. Runtime validation
rejects empty identities/bodies, malformed queue or conversation envelopes, and
incomplete relationship data; TypeScript unions constrain filters and mute
durations for typed callers. Scope/permission, Reddit API, and transport
failures preserve the shared exception contracts.

Outcome parity does not imply Python symbol identity or identical API shape.
Ledger verification requires complete scenario and pinned upstream evidence; the
separate 85-export manifest is nonblocking.

## Security and privacy

- Moderator notes and modmail are privileged, sensitive data. Callers own access
  control, logging redaction, retention, and deletion outside process memory.
- Every operation must require user authorization and appropriate Reddit scopes;
  read-only application auth is insufficient.
- Models should retain only returned data and must not combine data across
  moderator identities or clients.
- External integrations must not receive modmail bodies, participant details, or
  notes implicitly.

## Test ownership

- `tests/mod-notes-parity.test.ts`, `tests/moderation-domains.test.ts`, and
  `tests/moderation-edge.test.ts` own scoped notes, queue filters/streams,
  relationships, flair, rules, removal reasons, validation, and cancellation.
- `tests/modmail-domain.test.ts` owns modern/legacy listing, parsing, lifecycle
  mutations, streams, authorization, malformed responses, and cancellation.
- `tests/content-actions-edge.test.ts` owns comment crowd-control show, typed
  removal messages, and other comment/submission moderation actions.

## Related docs

- [Domain capabilities](domain-capabilities.md)
- [Reddit client runtime](reddit-client-runtime.md)
- [Compatibility ledger](compatibility-ledger.md)
