# Schema v2 migration

Schema v2 changes parity tracking from a symbol-completion checklist to an
outcome-and-evidence model. The migration may proceed concurrently with these
documentation changes; this document describes intent without editing the
ledger, manifest, validator, or scripts.

## Goals

- Make useful Reddit outcomes the unit of support.
- Keep PRAW's public-symbol inventory for traceability.
- Make the inventory manifest nonblocking.
- Separate intentional TypeScript adaptations from completion status.
- Attach reviewable evidence to every current support claim.
- Remove percentage-based reporting.

## Conceptual mapping

| Schema v1 concept           | Schema v2 treatment                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `implemented` capability    | Candidate `verified` scenario, shown publicly as Supported, after its full boundary and evidence are reviewed |
| `adapted` capability        | Scenario status plus a separate adaptation kind and rationale                                                 |
| `planned` workflow          | `missing` or `partial` scenario, shown publicly as Planned or Partial, depending on verified usable behavior  |
| `praw.models.__all__` entry | Entry in a separate manifest with `blocking: false`                                                           |
| Source and test paths       | Structured implementation, named-test, and pinned-upstream evidence                                           |

The mapping is not mechanical. Multiple v1 rows may form one outcome, and one
row may split into several scenarios with different statuses. Export-only shells
must not become verified scenarios.

## Migration sequence

1. Preserve the PRAW 8.0.3 baseline, source links, attribution, and licenses.
2. Introduce and validate the v2 top-level shape.
3. Move public-name accounting into the nonblocking model-export manifest
   without changing its provenance.
4. Define required outcomes and their scenario boundaries from currently tested
   behavior.
5. Attach implementation, named-test, upstream, and adaptation references.
6. Keep incomplete paths partial or missing rather than broadening claims.
7. Evaluate required outcomes and evidence for completion, never manifest
   entries.
8. Reconcile prose with the migrated ledger and remove temporary v1 wording.

## Concurrent-change safety

- The schema migration owns machine-readable parity files and their validator;
  documentation changes should not rewrite them opportunistically.
- Avoid hard-coded symbol totals, status counts, or percentages in prose.
- Treat the checked ledger and validator as authoritative for exact v2 fields.
- Resolve conflicts by preserving outcome boundaries, evidence semantics,
  attribution, and the nonblocking manifest rule rather than v1 layout.

## Completion criteria

Migration is complete when the ledger validates as v2, every support claim is a
verified scenario with sufficient evidence, incomplete scenarios remain partial
or missing, all PRAW symbols remain traceable in the nonblocking manifest, and
public docs no longer equate symbol export with behavior.
