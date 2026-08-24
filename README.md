# TRAW: TypeScript Reddit API Wrapper

TRAW is an unofficial TypeScript implementation of Reddit API capabilities,
using [PRAW 8.0.3](https://github.com/praw-dev/praw/tree/v8.0.3) as a pinned
behavioral reference. The goal is equivalent useful outcomes where TypeScript
and Python differ, not Python symbol identity or line-for-line API-shape parity.
TRAW intentionally uses TypeScript-native names and contracts where they
preserve the same observable behavior.

## Current status

The machine-readable [`parity/praw-8.0.3.json`](parity/praw-8.0.3.json) ledger
verifies all 16 required outcome groups and every scenario they contain. This
includes:

- current-account profile subreddit objectification;
- subreddit creation, settings reads and updates, moderator-invite acceptance,
  and quarantine opt-in/out;
- site-wide, subreddit-scoped, and redditor-scoped moderator-note workflows;
- showing crowd-controlled comments; and
- typed removal messages for comments and submissions.

Outcome parity is the compatibility claim: equivalent observable requests,
models, errors, pagination, and state transitions within the pinned ledger. It
does not require Python symbol identity or an identical public API shape. The
separate 85-export PRAW model manifest is a nonblocking migration inventory; an
export classification neither adds to nor limits outcome parity.

See the [parity guide](parity/README.md) for status semantics and evidence
policy. The machine-readable ledger remains the detailed source of truth.

TRAW follows Reddit API constraints, including OAuth, rate limits, and
appropriate user-agent identification. Applications remain responsible for
complying with Reddit's current API terms and policies.

## Requirements

- Node.js 22 or newer
- pnpm 10 for repository development

## Development setup

From a local checkout:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:types
```

`pnpm parity` verifies that every required ledger outcome and scenario satisfies
the completion rule. The 85-export manifest remains nonblocking.

## Examples

The examples below are limited to behavior that is currently implemented.
Network operations return promises; listings and polling streams are
asynchronous iterables.

```ts
import { Reddit } from "traw";

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
console.log(account.toString(), await reddit.account.preferences());

const community = reddit.subreddit("redditdev");
for await (const item of community.moderation.modqueue({ limit: 10 })) {
  console.log(item.fullname);
}
```

Generic polling accepts an `AbortSignal` and a listing fetcher:

```ts
import { streamGenerator } from "traw";

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
the intended Reddit outcome in TypeScript. See
[TypeScript adaptations](parity/adaptations.md) for the policy and its limits.

## Compatibility and attribution

TRAW is independently maintained and is not affiliated with, endorsed by, or
supported by the PRAW project or Reddit.

The API and behavior baseline is PRAW 8.0.3, created by the PRAW contributors.
PRAW is Copyright (c) 2016, Bryce Boe. The exact upstream sources used for
compatibility work are recorded in [Provenance](parity/provenance.md).

## Support

Use this repository's issue tracker for TRAW bugs and feature requests. General
Reddit API questions are better directed to Reddit's developer resources or
[r/redditdev](https://www.reddit.com/r/redditdev/). Search existing issues
before opening a new report.

## License

Original TRAW work is provided under the MIT License. Material derived or
adapted from PRAW 8.0.3 remains subject to PRAW's BSD 2-Clause license and
attribution requirements. See [Third-party notices](THIRD_PARTY_NOTICES.md) for
the full BSD notice and [Provenance](parity/provenance.md) for source details.
