# Media and Submission

**Status:** Implemented for tested standard, inline-rich-text, and asynchronous
media outcomes

## Overview

The media and submission layer snapshots local bytes, obtains an upload lease
from Reddit, uploads an identical multipart payload to the lease's S3-compatible
target, and submits the resulting URL or asset ID. It is memory-backed so
retries cannot observe a changed file.

## Interfaces and contracts

### Media snapshots

`Media` accepts a filesystem path or `Uint8Array`. Byte input requires a
filename. Construction copies the bytes immediately; later file or source-buffer
changes are not visible. `create()` returns an independent copy for each
attempt.

MIME type is inferred from `.gif`, `.jpeg`, `.jpg`, `.mov`, `.mp4`, `.png`,
`.webm`, or `.webp`. Optional construction and explicit validation limits are
byte counts and fail before upload.

### Lease and S3 upload

`PostMedia.upload()`:

1. validates an optional expected image/video MIME prefix;
2. requests `/api/media/asset.json` with filename and MIME type;
3. validates the lease action, asset ID, and all form fields;
4. snapshots a multipart form containing every lease field and the file;
5. posts it to the lease URL with `auth: false`, text response handling, and no
   `raw_json` parameter;
6. returns the asset ID for gallery/non-link upload types, otherwise returns the
   lease URL plus its `key` field.

The lease URL may be protocol-relative and is normalized to HTTPS. The returned
host is controlled by Reddit's lease response; no allowlist is currently
enforced.

### Submission variants

`Subreddit.submit(title, options)` uses a discriminated `kind` contract:

- `text` requires `selftext`;
- `link` requires `url` and may include self text;
- `poll` requires 2–6 non-empty choices and an integer duration from 1–7 days;
- `image` requires image media;
- `video` requires video media and may include a thumbnail or use GIF submission
  mode;
- `gallery` requires at least one image; captions are limited to 180 characters.

Text, link, image, video, and GIF outcomes use `/api/submit`; polls use
`/api/submit_poll_post`; galleries upload every item first and use
`/api/submit_gallery_post.json`. Common options cover NSFW, spoiler, replies,
and resubmission.

### Inline rich text

`InlineImage`, `InlineGif`, and `InlineVideo` wrap `PostMedia` with MIME
validation and an optional caption. Text submissions and `Submission.edit()`
accept a placeholder map such as `{hero}` to media objects. TRAW validates every
key and placeholder, uploads each item with `uploadType: "selfpost"`, replaces
placeholders with Reddit media Markdown, converts the body through
`/api/convert_rte_body_format`, and sends the returned `richtext_json`.

### WebSocket media completion

Image/video/GIF submissions wait for asynchronous processing by default when
Reddit returns a WebSocket URL. The client opens the injected or Node 22
WebSocket implementation, accepts text or binary updates, validates Reddit's
completion/failure envelope and redirect, and returns the redirected
`Submission`. `withoutWebSockets: true` opts out and returns the immediate
endpoint result; callers may inject `webSocketFactory`, set a timeout, or abort
with `AbortSignal`.

## Runtime and operational behavior

- Files are read synchronously and held in memory for the lifetime of the media
  object. Large media therefore affects event-loop latency and process memory.
- Gallery items upload sequentially. A later failure does not revoke earlier
  leases or uploaded assets.
- Multipart boundaries and bytes are stable for every retry of one upload body.
- Inline uploads are sequential; a later validation/conversion/submission
  failure does not revoke already uploaded assets.
- WebSocket monitoring is an in-process bounded wait. It closes the socket after
  success, failure, timeout, or cancellation and has no durable resume after
  process exit.
- Return shape depends on the variant and `withoutWebSockets`; processed
  image/video/GIF completion returns a `Submission`, while immediate endpoint
  paths retain their documented objectified result.

## Errors and recovery

- Unknown extensions, missing byte-source names, MIME mismatches, invalid
  variants, and malformed leases fail before or between requests with
  `TypeError`/`RangeError`.
- S3 XML containing `ProposedSize` and `MaxSizeAllowed` maps to
  `TooLargeMediaException`.
- Other S3 `ResponseException` failures map to `ServerError`; non-response
  failures propagate unchanged.
- Gallery JSON error tuples become `RedditAPIException`.
- Processing failures map to `MediaPostFailed`; malformed updates,
  connection/setup errors, premature close, invalid redirects, and timeout map
  to `WebSocketException`. Cancellation preserves abort semantics.
- Runtime retries are safe because bytes and multipart forms are replayable, but
  retry eligibility remains controlled by the session/transport policy.

## Security and privacy

- Uploads send OAuth only to Reddit's lease endpoint; the external upload
  explicitly disables OAuth headers.
- Lease fields are signed credentials and should not be logged. TRAW keeps them
  only in request memory.
- The library trusts Reddit's lease action URL. Applications using custom
  transports should preserve the `auth: false` boundary and HTTPS normalization.
- The library also trusts Reddit's media-completion WebSocket URL; no host
  allowlist is enforced.
- Media may contain sensitive content or metadata; TRAW does not inspect,
  transform, strip, encrypt, or persist it.

## Key decisions

- **Memory snapshots:** guarantee retry consistency and isolate source mutation,
  trading off memory use and synchronous file reads.
- **Lease fields are opaque:** all fields are forwarded unchanged so the upload
  stays compatible with Reddit/S3 policy changes.
- **Discriminated submission options:** invalid variant combinations fail at
  compile time where possible and at runtime for value constraints.
- **Injectable WebSocket factory:** keeps media completion testable and allows
  host integration without hiding the asynchronous boundary.

Emoji, stylesheet, and widget media reuse immutable bytes and unauthenticated
external uploads but use separate lease protocols; see
[Community administration](community-administration.md). The compatibility
ledger verifies the required PRAW 8.0.3 media outcomes; that outcome claim does
not imply Python symbol or API-shape identity.

## Test ownership

- `tests/media-upload.test.ts` — lease parsing, complete multipart forwarding,
  return values, and S3 error mapping.
- `tests/model-capabilities.test.ts` — media snapshots and text/poll submission
  contracts.
- `tests/models-edge-cases.test.ts` — image, video/GIF, gallery, validation, and
  endpoint outcomes.
- `tests/media-outcomes.test.ts` — inline placeholder conversion/editing and
  WebSocket success, failure, timeout, cancellation, binary, and opt-out
  behavior.
- `tests/core/transport.test.ts` — replayable multipart identity.

## Related docs

- [Architecture](../ARCHITECTURE.md)
- [Reddit client runtime](reddit-client-runtime.md)
- [Compatibility ledger](compatibility-ledger.md)
