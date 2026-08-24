# Compatibility Ledger

**Status:** Active; all required schema-v2 outcomes and scenarios verified

## Overview

TRAW pins compatibility planning to PRAW 8.0.3. The machine-readable ledger at
`parity/praw-8.0.3.json` is the authoritative capability checklist; this design
explains how to interpret and maintain it without turning exported names into
false implementation claims.

## Compatibility contract

Parity means equivalent observable outcomes for the capability being claimed:

- request path, method, parameters, body, batching, and authentication boundary;
- validation timing and failure category;
- response/model shape, identity, hydration, and state transition;
- pagination ordering and termination;
- retries, rate-limit waits, cancellation, and partial failure;
- exception type and relevant structured data.

Python syntax, symbol identity, and API shape are not outcome contracts.
Intentional TypeScript adaptations include camel-case public names, promises,
options objects, explicit `load()`/`refresh()`, `AsyncIterable`
listings/streams, `AbortSignal`, explicit equality, `TRAW_*` configuration, and
replayable byte-backed media.

## Status definitions

| Status        | Meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `missing`     | Required behavior has no implementation evidence.                                    |
| `partial`     | Some behavior exists, but the full scenario is not evidenced.                        |
| `verified`    | The scenario has exact implementation, focused tests, and pinned upstream evidence.  |
| `excluded`    | The scenario is intentionally outside parity with a recorded decision and rationale. |
| `unavailable` | Upstream behavior cannot be exercised and the reason is recorded.                    |

Status applies only to the described outcome or scenario. Implemented source and
passing tests do not by themselves promote a broad scenario when its upstream
evidence or remaining branches are incomplete. The completion rule requires
every required outcome and scenario to be `verified`, `excluded`, or
`unavailable`. `parity/praw-8.0.3.json` meets that rule: all 16 required outcome
groups and all of their scenarios are `verified`.

## Sources of truth and ownership

1. `parity/praw-8.0.3.json` owns outcome/scenario status, unsupported
   boundaries, and implementation/test/upstream evidence.
2. `parity/provenance.md` owns the pinned upstream materials and licensing
   provenance.
3. `parity/adaptations.md` owns intentional language/runtime differences.
4. `docs/designs/` owns TRAW contracts, runtime boundaries, failure behavior,
   and implemented boundaries.
5. Source and tests own actual behavior. Documentation or ledger text cannot
   override code.

Design docs summarize capability groups and link to the ledger; they should not
duplicate all entries. If these sources disagree, downgrade the claim until
code, tests, ledger, adaptations, and docs agree.

## Promotion workflow

Before changing a `missing` or `partial` scenario to `verified`:

1. verify the behavior against the PRAW 8.0.3 pinned source and relevant
   prawcore behavior;
2. define the TypeScript contract and any intentional adaptation;
3. implement complete observable outcomes rather than only an exported symbol or
   happy-path request;
4. add focused runtime tests and public type tests;
5. test validation, malformed responses, errors, pagination/state, cancellation,
   auth, and retry behavior where applicable;
6. record adaptation and provenance changes when needed;
7. update the ledger source/test paths and status;
8. run the repository checks and review affected design docs.

An entry should be demoted when implementation is removed, its verification no
longer passes, or its description overstates the tested outcome.

## Runtime and operational implications

- The ledger is build-time repository data; TRAW does not load it at runtime.
- Compatibility checks are deterministic and local. They do not prove live
  Reddit availability or credentials/scopes.
- Cassette or mocked tests verify known exchanges; live-service drift still
  requires review against current Reddit behavior without changing the pinned
  PRAW baseline silently.
- The separate 85-export PRAW model manifest is nonblocking and supports
  migration planning only. It classifies symbol-surface presence; it neither
  establishes nor constrains outcome parity.

## Errors and failure policy

- A missing source/test/upstream reference, undocumented adaptation, invalid
  status, or incomplete required scenario must prevent a full-parity claim.
- A passing unit test is insufficient when the capability description includes
  untested branches or state transitions.
- Endpoint success alone is insufficient for outcome parity when PRAW returns a
  model, mutates local state, paginates, or maps errors differently.
- Compatibility gaps are recorded as `missing` or `partial`, not hidden behind
  permissive response shells.

## Security and privacy

- Upstream examples and cassettes must not introduce credentials, OAuth tokens,
  lease fields, private messages, moderator data, or user-identifying fixtures.
- Error-parity tests must use synthetic secrets and verify redaction where
  applicable.
- Provenance must be updated for substantially translated material and converted
  fixtures.
- Compatibility does not justify weakening HTTPS, OAuth scope checks,
  external-upload header separation, or caller cancellation.

## Test ownership

- `scripts/check-parity.mjs` validates ledger completeness/status policy.
- Each verified scenario's evidence lists its primary implementation, tests, and
  pinned upstream owner.
- `tests/types/public-api.ts` owns compile-time API contracts.
- Domain design docs identify focused suites and implementation boundaries; they
  do not override ledger status.

## Related docs

- [Architecture](../ARCHITECTURE.md)
- [Reddit client runtime](reddit-client-runtime.md)
- [Models, listings, and streams](models-listings-and-streams.md)
- [Media and submission](media-and-submission.md)
- [Domain capabilities](domain-capabilities.md)
