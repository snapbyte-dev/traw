# Parity evidence

Evidence answers how strongly an outcome scenario has been verified. It does not
measure how much code exists, and an implementation path alone is insufficient.

## Evidence levels

From weakest to strongest:

| Level      | Demonstrates                                                                                      | Does not demonstrate                                                     |
| ---------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Inventory  | An upstream name has been identified or exported                                                  | Usable behavior                                                          |
| Contract   | Types, validation, construction, or public shape are checked                                      | Network workflow equivalence                                             |
| Behavioral | Deterministic tests exercise outputs, errors, state changes, pagination, retries, or cancellation | Current live Reddit behavior                                             |
| Protocol   | Recorded or synthetic interactions verify request and response semantics at a transport boundary  | Continuing interoperability with the live service                        |
| Live       | A controlled test has exercised the current Reddit service                                        | Permanent compatibility or behavior outside the tested account and scope |

Higher evidence supplements rather than erases lower-level checks. Evidence
references should identify what was exercised and be narrow enough to review.

Schema v2 encodes the required traceability dimensions as `implementation`,
`tests`, and `upstream` arrays rather than storing the level labels above. The
levels are the review policy for interpreting those references. Named tests are
checked against their files, and upstream URLs are pinned to PRAW 8.0.3.

## Minimum claim rules

- **Supported** (`verified` in the ledger) requires behavioral evidence for
  every acceptance boundary. Protocol-sensitive outcomes also require protocol
  evidence when request shape cannot be established adequately by isolated
  tests.
- **Partial** (`partial`) requires behavioral evidence for the claimed working
  subset and a written unsupported boundary.
- **Planned** (`missing`) requires no implementation evidence and must make no
  current support claim.
- **Inventory** and implementation references never justify `verified` or
  `partial` by themselves.
- **Live** evidence is valuable but is not assumed or required unless an outcome
  explicitly says so.
- **Excluded** and **unavailable** scenarios require their schema dispositions;
  terminal status does not turn them into supported behavior.

## Current evidence posture

TRAW currently relies primarily on deterministic unit and component-level
behavioral tests. Transport cassette infrastructure verifies strict matching,
redaction policy, and replay mechanics with a synthetic fixture. That harness
must not be described as proof that all outcomes were recorded from, or tested
against, live Reddit.

Evidence can become stale when an outcome boundary, implementation, fixture, or
baseline changes. Reviewers should update or remove the claim rather than retain
a reference that no longer tests the stated behavior.
