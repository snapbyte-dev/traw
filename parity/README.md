# Capability parity

TRAW measures parity by user and developer outcomes: whether a TypeScript caller
can complete the same Reddit task with equivalent validation, requests,
responses, errors, pagination, and state changes. Matching every Python symbol
or call shape is not the goal.

The baseline is pinned to PRAW 8.0.3. This directory explains how claims are
made:

- [Schema](schema.md) defines outcome records, the nonblocking symbol inventory,
  status, and evidence references.
- [Evidence](evidence.md) defines evidence levels and the minimum support rules.
- [TypeScript adaptations](adaptations.md) records intentional language and
  runtime differences.
- [Migration](migration.md) describes the conceptual move to schema v2.
- [Provenance](provenance.md) records upstream sources and licenses.

## Status model

- **Supported**: the stated outcome and its acceptance boundaries are
  implemented and backed by sufficient evidence.
- **Partial**: a useful subset works, but a documented boundary or important
  path remains unsupported.
- **Planned**: the outcome is part of the baseline or intended scope, but no
  usable support is claimed.

Status applies to the exact outcome description. It does not automatically
extend to a class, module, or neighboring PRAW feature.

These are reader-facing labels. In schema v2, `verified` is shown as Supported,
`partial` as Partial, and `missing` as Planned. The machine statuses `excluded`
and `unavailable` require an explicit disposition and do not claim support.

## Current outcome summary

| Outcome                                             | Status    | Boundary                                                                                       |
| --------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| OAuth authorization and resilient request execution | Supported | Implemented authorization modes, transport retries, rate limits, decoding, and objectification |
| Asynchronous listing traversal                      | Supported | Tested after/before pagination, limits, parameters, and cancellation                           |
| Submission and comment workflows                    | Partial   | Common reads and mutations plus recursive comments; not the full PRAW model surface            |
| Supported post creation                             | Supported | Text, link, poll, image, video, GIF, and gallery variants                                      |
| Account, discovery, and community helpers           | Partial   | Only the selected helpers identified in the root README and ledger                             |
| Polling streams                                     | Partial   | Generic polling works; specialized stream helpers remain outside current support               |
| Remaining PRAW workflows                            | Planned   | Inventory coverage is not behavioral support                                                   |

This table deliberately has no percentage. Outcomes differ in size and risk, and
the symbol inventory includes shells that must not inflate a progress claim.

## Symbol inventory

The inventory answers, “Which PRAW 8.0.3 public names have been accounted for?”
It supports discovery and migration planning. It is nonblocking: presence,
absence, or export of a name cannot make an outcome supported and does not fail
outcome-completion policy by itself.

Some currently exported model names are foundations or response containers with
no PRAW-equivalent network workflow. Callers should rely only on documented
outcomes with evidence.

## Known limitations

- The broader PRAW model, helper, moderator, modmail, widget, wiki, trophy,
  preference, and relationship workflows are not implemented.
- Several exported names provide identity, response storage, or type shape only.
- Generic polling is available, but specialized subreddit stream helpers are
  not.
- Evidence is primarily deterministic local behavioral testing. A fixture or
  unit test is not a claim of current live Reddit interoperability.
- The ledger and related model-export manifest are transitioning to schema v2.
  During migration, the checked ledger and validator determine the actual
  recorded state.
