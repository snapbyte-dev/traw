# TRAW: TypeScript Reddit API Wrapper

TRAW is an unofficial TypeScript port of
[PRAW](https://github.com/praw-dev/praw), designed to provide a familiar, typed
interface to Reddit from modern Node.js applications. The compatibility baseline
is explicitly pinned to
[PRAW 8.0.3](https://github.com/praw-dev/praw/tree/v8.0.3).

The project is under active development, private, unpublished, and not ready for
general use. It does not yet provide full PRAW parity. Progress and test
evidence are tracked in the
[PRAW 8.0.3 capability ledger](parity/praw-8.0.3.json).

Currently tested scope includes OAuth client, script, refresh-token, web-code,
and installed-app flows; request dispatch, transport retry, header rate
limiting, API `RATELIMIT` retry, and response objectification; after- and
before-cursor async listings and polling streams; lazy top-level model
factories; recursive submission comment forests and common comment/submission
mutations; media lease and multipart upload; text, link, poll, image, video,
GIF, and gallery submission; and selected front-page, inbox, draft,
announcement, live-thread, multireddit, subreddit discovery, and moderator-note
helpers. Many PRAW models are name-compatible exports only and remain planned
until meaningful behavior is implemented and tested.

TRAW follows Reddit API constraints, including OAuth, rate limits, and
appropriate user-agent identification. Applications remain responsible for
complying with Reddit's current API terms and policies.

## Requirements

- Node.js 22 or newer
- pnpm 10 for repository development

## Development setup

This repository uses pnpm for contributor workflows only. Install dependencies
from a local checkout:

```bash
pnpm install
```

Passing development checks are:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:types
```

`pnpm parity` and therefore `pnpm check` currently fail while the ledger
contains `planned` capabilities. They are completion gates, not current progress
checks.

## Quickstart

The implemented API is asynchronous. Given credentials for a Reddit script
application, create a client with explicit configuration:

```ts
import { Reddit } from "traw";

const reddit = new Reddit({
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  username: process.env.REDDIT_USERNAME!,
  password: process.env.REDDIT_PASSWORD!,
  userAgent: "example:traw-demo:v0.1 (by /u/example)",
});
```

Network operations return promises, while listings and polling streams are
asynchronous iterables:

```ts
const test = reddit.subreddit("test");

await test.submit("Test submission", {
  kind: "link",
  url: "https://www.reddit.com/",
});

const submission = reddit.submission({ id: "5e1az9" });
await submission.reply("Hello from TypeScript");

for await (const post of reddit.front.hot({ limit: 25 })) {
  console.log(post.title, post.score);
}
```

The standalone polling stream accepts an `AbortSignal` and a listing fetcher:

```ts
const controller = new AbortController();

import { streamGenerator } from "traw";

const posts = streamGenerator(
  ({ limit, before, signal }) =>
    reddit.subreddit("redditdev").new({
      limit,
      params: before === undefined ? {} : { before },
      signal,
    }),
  { signal: controller.signal },
);

for await (const post of posts) {
  if (post !== null) console.log(post.title);
}
```

The stream fetcher above uses a submission listing only to demonstrate the
polling contract; specialized subreddit comment-stream helpers are not yet
implemented. Consult the parity ledger before relying on a capability.

## TypeScript adaptations

TRAW targets equivalent Reddit behavior rather than line-for-line Python API
syntax. Important adaptations include camel-cased names, options objects,
promises for network work, `AsyncIterable` listings and streams, explicit model
hydration, and `AbortSignal` cancellation. The complete policy is documented in
[TypeScript adaptations](parity/adaptations.md).

## Compatibility and attribution

TRAW is independently maintained and is not affiliated with, endorsed by, or
supported by the PRAW project or Reddit.

The API and behavior baseline is PRAW 8.0.3, created by the PRAW contributors.
PRAW is Copyright (c) 2016, Bryce Boe. The exact upstream sources used to build
the compatibility ledger are recorded in [Provenance](parity/provenance.md).

## Support

Use this repository's issue tracker for TRAW bugs and feature requests. General
Reddit API questions are better directed to Reddit's developer resources or
[r/redditdev](https://www.reddit.com/r/redditdev/). Please search existing
issues before opening a new report.

## License

Original TRAW work is provided under the MIT License. Material derived or
adapted from PRAW 8.0.3 remains subject to PRAW's BSD 2-Clause license and
attribution requirements. See [Third-party notices](THIRD_PARTY_NOTICES.md) for
the full BSD notice and [Provenance](parity/provenance.md) for source details.
