# Provenance

TRAW uses the PRAW 8.0.3 tag as its pinned behavioral reference. Compatibility
work should use that tag rather than PRAW's moving default branch or current
documentation.

| Material                                             | Pinned source                                                                             | License      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| Public API and behavior reference                    | [PRAW 8.0.3 source](https://github.com/praw-dev/praw/tree/v8.0.3)                         | BSD-2-Clause |
| `Reddit` behavior                                    | [`praw/reddit.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/reddit.py)           | BSD-2-Clause |
| Authorization behavior                               | [`praw/models/auth.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/models/auth.py) | BSD-2-Clause |
| Request, OAuth, retry, and rate-limit behavior       | prawcore 4.x used by PRAW 8.0.3                                                           | BSD-2-Clause |
| Original documentation and TypeScript implementation | TRAW contributors                                                                         | MIT          |
| Cassette replay test harness and synthetic fixtures  | Original TRAW test infrastructure                                                         | MIT          |

PRAW sources inform expected behavior; TRAW's TypeScript API and focused local
tests define its supported boundaries. Original TRAW material remains
MIT-licensed. Material derived or adapted from PRAW remains subject to PRAW's
BSD 2-Clause license and attribution requirements. PRAW is Copyright (c) 2016,
Bryce Boe.

Substantially translated files and converted fixtures should be documented here
as they are introduced. See [Third-party notices](../THIRD_PARTY_NOTICES.md) for
the full BSD notice.
