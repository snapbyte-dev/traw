# TRAW: TypeScript Reddit API Wrapper

[![npm version](https://img.shields.io/npm/v/%40snapbyte-dev%2Ftraw.svg)](https://www.npmjs.com/package/@snapbyte-dev/traw)

TRAW is an unofficial TypeScript implementation of Reddit API capabilities,
using [PRAW 8.0.3](https://github.com/praw-dev/praw/tree/v8.0.3) as a pinned
behavioral reference. The goal is equivalent useful outcomes where TypeScript
and Python differ, not Python symbol identity or line-for-line API-shape parity.
TRAW intentionally uses TypeScript-native names and contracts where they
preserve the same observable behavior.

## Current status

TRAW implements the documented TypeScript API boundaries for authentication,
requests, models, listings, streams, submissions, account workflows, and Reddit
domains. Focused local tests define those supported boundaries. PRAW 8.0.3 is a
behavioral reference, not a promise of Python-compatible symbols or call shapes.

Local and mocked tests do not guarantee current interoperability with live
Reddit. See [Compatibility](docs/COMPATIBILITY.md) for the claim and evidence
policy.

TRAW follows Reddit API constraints, including OAuth, rate limits, and
appropriate user-agent identification. Applications remain responsible for
complying with Reddit's current API terms and policies.

## Requirements

- Node.js 22 or newer
- pnpm 10 for repository development

## Installation

```bash
pnpm add @snapbyte-dev/traw
```

## Development setup

From a local checkout:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:types
```

## Examples

The examples below are limited to behavior that is currently implemented.
Network operations return promises; listings and polling streams are
asynchronous iterables.

To run the top-posts example, create `.env` from `.env.example`, add your Reddit
application credentials, and run:

```bash
pnpm example:top-posts
```

The example fetches the top 10 posts from r/typescript and prints their titles.

```ts
import { Reddit } from "@snapbyte-dev/traw";

const reddit = new Reddit({
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  username: process.env.REDDIT_USERNAME!,
  password: process.env.REDDIT_PASSWORD!,
  userAgent: "example:traw-demo:v0.1 (by /u/example)",
});

for await (const post of reddit.front.hot({ limit: 25 })) {
  console.log(post.title, post.score);
}

const submission = reddit.submission({ id: "5e1az9" });
await submission.reply("Hello from TypeScript");

const account = await reddit.account.me();
const preferences = await reddit.account.preferences.get();
await reddit.account.preferences.update({ ...preferences, nightmode: true });
console.log(account.toString());

const drafts = await reddit.drafts.list();
const draft = reddit.drafts.reference("draft-id");
const createdDraft = await reddit.drafts.create({
  subreddit: "redditdev",
  title: "Typed draft",
  selftext: "Hello from TypeScript",
});

for await (const announcement of reddit.announcements.list({ limit: 10 })) {
  console.log(announcement.fullname);
}

const thread = reddit.live.reference("live-thread-id");
const multis = await reddit.multireddits.mine();

const community = reddit.subreddit("redditdev");
for await (const item of community.moderation.modqueue({ limit: 10 })) {
  console.log(item.fullname);
}
```

Generic polling accepts an `AbortSignal` and a listing fetcher:

```ts
import { streamGenerator } from "@snapbyte-dev/traw";

const controller = new AbortController();
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

Specialized adapters use the same polling contract:

```ts
for await (const comment of reddit.subreddit("redditdev").stream.comments({
  skipExisting: true,
  signal: controller.signal,
})) {
  if (comment !== null) console.log(comment.body);
}
```

## TypeScript adaptations

TRAW uses camel-cased names, options objects, promises, `AsyncIterable`,
explicit hydration, and `AbortSignal` cancellation where those forms preserve
the intended Reddit outcome in TypeScript. Domain helpers are class APIs rather
than Python-callable objects. See [Compatibility](docs/COMPATIBILITY.md).

## Compatibility and attribution

TRAW is independently maintained and is not affiliated with, endorsed by, or
supported by the PRAW project or Reddit.

The API and behavior baseline is PRAW 8.0.3, created by the PRAW contributors.
PRAW is Copyright (c) 2016, Bryce Boe. The exact upstream sources used for
compatibility work are recorded in [Provenance](docs/PROVENANCE.md).

## Support

Use this repository's issue tracker for TRAW bugs and feature requests. General
Reddit API questions are better directed to Reddit's developer resources or
[r/redditdev](https://www.reddit.com/r/redditdev/). Search existing issues
before opening a new report.

## License

Original TRAW work is provided under the MIT License. Material derived or
adapted from PRAW 8.0.3 remains subject to PRAW's BSD 2-Clause license and
attribution requirements. See [Third-party notices](THIRD_PARTY_NOTICES.md) for
the full BSD notice and [Provenance](docs/PROVENANCE.md) for source details.
