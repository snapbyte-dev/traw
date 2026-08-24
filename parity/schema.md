# Parity ledger schema

Schema v2 separates behavioral outcomes from public-symbol accounting. This
prevents export-only model shells from being treated as completed features.

## Top-level contract

The ledger retains a pinned baseline and provenance source, declares
`schemaVersion: 2`, and contains:

1. **Outcomes**, divided into reviewable scenarios, which describe tasks a
   caller can complete.
2. **Manifest references** to nonblocking inventories such as the PRAW model
   exports.

The checked validator is authoritative while the v2 migration is landing.

## Machine status and public status

| Machine status | Public meaning                      | Completion treatment                 |
| -------------- | ----------------------------------- | ------------------------------------ |
| `verified`     | Supported                           | Terminal                             |
| `partial`      | Partial                             | Incomplete                           |
| `missing`      | Planned                             | Incomplete                           |
| `excluded`     | Outside the agreed parity boundary  | Terminal with rationale and decision |
| `unavailable`  | Prevented by an external constraint | Terminal with a reason               |

Supported, Partial, and Planned are the reader-facing labels used in outcome
tables. Adaptation is recorded separately and is not a status.

## Outcome and scenario records

Every outcome has:

- a unique kebab-case `id` and concise `outcome` statement;
- a machine `status`;
- `required: true`, making outcome completion blocking; and
- one or more scenarios that define the acceptance boundary.

Each scenario has its own globally unique ID, statement, status, evidence
object, and optional adaptation. Evidence is grouped into implementation
references, named tests, and pinned upstream references. Terminal scenarios
require all three. `excluded` scenarios carry an exclusion rationale and
decision; `unavailable` scenarios carry an unavailable reason.

An outcome is terminal exactly when all of its scenarios are terminal. Narrow or
split scenarios instead of marking a partly tested boundary verified. Outcomes
are the only records used to make capability claims.

## Nonblocking manifest

The ledger references a separate schema-v2 manifest for public-symbol
accounting. A manifest declares the same baseline, sets `blocking: false`, and
includes evidence for the test that checks inventory shape. Each export records
its name, classification, machine status, implementation reference, and pinned
upstream reference. Aliases also identify the export they map to.

Manifest rules:

- Export presence is not implementation evidence.
- A symbol may contribute to zero, one, or several outcomes.
- Several symbols may contribute to one outcome; no one-to-one mapping is
  required.
- Manifest entries are nonblocking for outcome completion.
- Missing behavioral coverage belongs in an outcome, not in an inflated symbol
  count or percentage.

## Evidence references

Evidence belongs to a scenario. Its `implementation`, `tests`, and `upstream`
arrays provide distinct dimensions of traceability. Test references include a
repository path and focused test name; upstream references include a symbol and
URL pinned to the PRAW 8.0.3 source tree. An implementation reference alone is
never enough to verify behavior. See [Evidence](evidence.md).

## Adaptations

A scenario adaptation records a `kind` and `rationale` explaining why an
equivalent outcome has a different TypeScript interface or runtime form.
Adaptation is not a separate status: its scenario is still verified, partial, or
missing based on behavior and evidence.

## Validation invariants

- The baseline remains PRAW 8.0.3 unless changed by an explicit compatibility
  decision.
- Outcome and scenario identifiers are globally unique kebab-case values.
- Every terminal scenario has implementation, named-test, and pinned-upstream
  evidence.
- Outcome status agrees with scenario terminality.
- Excluded and unavailable entries carry their required dispositions.
- Referenced repository paths and named tests exist.
- Manifest baseline and schema version match the ledger, and the manifest is
  explicitly nonblocking.
- Inventory state never upgrades outcome status.
- No aggregate percentage is derived from outcomes or symbols.
