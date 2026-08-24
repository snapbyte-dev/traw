# Provenance

The parity baseline is pinned to the PRAW 8.0.3 tag. Ledger entries should be
checked against that tag rather than PRAW's moving default branch or current
documentation.

| Material                                             | Pinned source                                                                                     | License      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------ |
| Public API and behavior baseline                     | [PRAW 8.0.3 source](https://github.com/praw-dev/praw/tree/v8.0.3)                                 | BSD-2-Clause |
| Top-level `praw` exports                             | [`praw/__init__.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/__init__.py)               | BSD-2-Clause |
| `Reddit` public facade                               | [`praw/reddit.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/reddit.py)                   | BSD-2-Clause |
| The 85 `praw.models.__all__` names                   | [`praw/models/__init__.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/models/__init__.py) | BSD-2-Clause |
| Exact `Auth` public surface                          | [`praw/models/auth.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/models/auth.py)         | BSD-2-Clause |
| PRAW exception hierarchy                             | [`praw/exceptions.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/exceptions.py)           | BSD-2-Clause |
| Request, OAuth, retry, and rate-limit behavior       | prawcore 4.x used by PRAW 8.0.3                                                                   | BSD-2-Clause |
| Original documentation and TypeScript implementation | TRAW contributors                                                                                 | MIT          |
| Cassette replay test harness                         | Original TRAW test infrastructure                                                                 | MIT          |
| `tests/fixtures/example-cassette.json`               | Original synthetic fixture; no upstream material                                                  | MIT          |

The capability ledger records public behavior and names for compatibility
planning. An entry marked `implemented` requires implementation and test
verification; an entry marked `adapted` additionally requires an explanation in
`parity/adaptations.md`. Exporting a class name alone is not implementation of
that model's PRAW behavior. The current `planned` entries make the parity check
fail by design.

Substantially translated files and converted fixtures must be added to this
table as they are introduced.
