# Community Administration

**Status:** Implemented for the documented, locally tested boundaries

## Overview

Community administration is exposed through `reddit.subreddits` and helpers
scoped from `reddit.subreddit(name)`. Source and focused tests cover the
documented administration boundaries for community creation, settings,
invitations, quarantine, moderation queues, relationships, flair, rules, removal
reasons, wiki, emoji, stylesheet assets, widgets, and collections.

## Implemented contracts

| Surface                                         | Current contract                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subreddits.create`, `moderation`, `quarantine` | Community creation with PRAW defaults and remapped settings; edited/modqueue/reports/spam/unmoderated queues; mod log and polling adapters; typed settings read/update; moderator-invite acceptance; and quarantine opt-in/out. |
| Relationships                                   | Banned, muted, contributor, moderator, wiki-banned, and wiki-contributor listings and mutations, including moderator invitations and permission updates.                                                                        |
| `flair`                                         | User/link flair assignment and clearing, configuration, template list/create/update/delete/reorder, and user deletion.                                                                                                          |
| `rules`, `removalReasons`                       | Ordered reads plus validated create/update/delete; rules also support reorder and partial updates fetch retained fields.                                                                                                        |
| `wiki`                                          | Page list/reference/create/load/edit, optimistic previous revision, page/global revisions, revert, discussions, settings, editors, and wiki relationships.                                                                      |
| `emoji`                                         | List/reference/refresh, leased replayable upload, permissions update, and delete.                                                                                                                                               |
| `stylesheet`                                    | Legacy stylesheet read/update and named/header/mobile image operations; redesign banner/mobile assets use leases, unauthenticated upload, and structured-style patches.                                                         |
| `widgets`                                       | Typed fetch/refresh and layout access; supported widget creation, update/delete, ordering, and leased image upload.                                                                                                             |
| `collections`                                   | List/reference/permalink lookup, hydration, create, follow/unfollow, add/remove/reorder posts, update title/description/layout, and delete.                                                                                     |

Reads use promises for bounded resources and `Listing`/`AsyncIterable` for
cursor-backed resources. Mutations distinguish omitted fields where the endpoint
supports partial updates and validate identities, lengths, enums, ordering, and
response envelopes before reporting success.

## Runtime and state

- Administration remains client-side library behavior; Reddit is the source of
  truth and there is no local database.
- Mutations pass through OAuth, rate-limit, retry, and cancellation policy.
  Non-idempotent retries require endpoint-specific outcome analysis.
- Resource models do not report loaded or updated state until the required
  server response has been validated. Widgets retain the latest fetched
  snapshot; partial rule/removal-reason/emoji updates may first fetch current
  values.

## Errors and recovery

Administration validates names, IDs, lengths, MIME types, ordering, and mutually
exclusive fields before dispatch where possible, then preserves Reddit API and
HTTP failures.

Multi-request workflows are not transactional. If a later request fails, earlier
mutations or uploads may remain applied; TRAW does not claim rollback. Malformed
response data rejects the operation rather than producing a nominal resource
shell.

## Security and privacy

- Administration requires user authorization and endpoint-specific moderator
  scopes/permissions; possession of a `Subreddit` reference conveys no
  authority.
- Settings, private communities, role membership, and unpublished assets may be
  sensitive. TRAW does not provide durable encryption, audit logs, or policy
  enforcement.
- Asset lease fields and OAuth headers must stay separated. Custom
  endpoints/transports are trusted components.
- Callers own confirmation and authorization UX for destructive operations.

## Key decisions

- **Evidence, not export names:** the contracts above are backed by focused
  tests; other exported names do not imply operational support.
- **Server-confirmed state:** avoids local models drifting from Reddit after
  permission, validation, or conflict failures.
- **Domain-specific asset protocols:** prevents unsafe reuse of submission
  assumptions for widgets, emojis, or stylesheet uploads.

## Test ownership

- `tests/subreddit-administration.test.ts`, `tests/moderation-domains.test.ts`,
  and `tests/moderation-edge.test.ts` — community creation, settings,
  invitations, quarantine, queues, relationships, flair, notes, rules, and
  removal reasons.
- `tests/wiki-domain.test.ts`, `standalone-emoji.test.ts`, and
  `standalone-stylesheet.test.ts` — page and asset lifecycles.
- `tests/widgets-domain.test.ts` and `collections-domain.test.ts` — typed
  widget/layout behavior, media upload, and collection lifecycle.
- Compatibility changes should cite pinned upstream behavior where relevant and
  add focused tests for the documented boundary.

## Related docs

- [Domain capabilities](domain-capabilities.md)
- [Media and submission](media-and-submission.md)
- [Compatibility](../COMPATIBILITY.md)
