# Provenance

The parity baseline is pinned to the PRAW 8.0.3 tag. Outcomes and symbol
inventory entries must be checked against that tag rather than PRAW's moving
default branch or current documentation.

| Material                                             | Pinned source                                                                                     | License      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------ |
| Public API and behavior baseline                     | [PRAW 8.0.3 source](https://github.com/praw-dev/praw/tree/v8.0.3)                                 | BSD-2-Clause |
| Top-level `praw` exports                             | [`praw/__init__.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/__init__.py)               | BSD-2-Clause |
| `Reddit` public facade                               | [`praw/reddit.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/reddit.py)                   | BSD-2-Clause |
| The `praw.models.__all__` names                      | [`praw/models/__init__.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/models/__init__.py) | BSD-2-Clause |
| Exact `Auth` public surface                          | [`praw/models/auth.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/models/auth.py)         | BSD-2-Clause |
| PRAW exception hierarchy                             | [`praw/exceptions.py`](https://github.com/praw-dev/praw/blob/v8.0.3/praw/exceptions.py)           | BSD-2-Clause |
| Request, OAuth, retry, and rate-limit behavior       | prawcore 4.x used by PRAW 8.0.3                                                                   | BSD-2-Clause |
| Original documentation and TypeScript implementation | TRAW contributors                                                                                 | MIT          |
| Cassette replay test harness                         | Original TRAW test infrastructure                                                                 | MIT          |
| `tests/fixtures/example-cassette.json`               | Original synthetic fixture; no upstream material                                                  | MIT          |

## Use of upstream material

PRAW sources define the compatibility baseline and inform expected behavior.
TRAW's outcome ledger records behavior and its symbol inventory records public
names for traceability. Neither an inventory entry nor a matching export is a
claim that the corresponding PRAW behavior is implemented.

A supported outcome requires implementation and evidence as defined in
[Evidence](evidence.md). An intentional language difference also requires an
explanation in [TypeScript adaptations](adaptations.md). The schema-v2 migration
changes this accounting model but does not change the pinned source, ownership,
or license of any material.

Substantially translated files and converted fixtures must be added to the table
as they are introduced. Original TRAW material remains MIT-licensed; derived or
adapted PRAW material remains subject to PRAW's BSD 2-Clause license and
attribution requirements.
