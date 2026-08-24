# TypeScript adaptations

The parity baseline is PRAW 8.0.3. TRAW targets equivalent Reddit outcomes,
validation, requests, responses, errors, pagination, and state transitions. It
does not reproduce Python syntax when a TypeScript-native form preserves those
semantics more clearly.

Intentional adaptations include:

- Public TypeScript names use camel case.
- Network operations return promises.
- Listings and polling streams implement `AsyncIterable`.
- `Listing` is a single-use lazy async iterable, and `ListingGenerator` is an
  alias of that implementation rather than a separate generator type.
- Lazy model factories are synchronous, but hydration requires `load()` or
  `refresh()` because JavaScript property access cannot await network I/O.
- Python keyword-only arguments become options objects.
- Python equality and hashing become explicit identity and `equals()` methods.
- `AbortSignal` provides cancellation for requests, waits, and streams.
- Configuration uses constructor options and `TRAW_*` environment variables;
  `praw.ini` is intentionally unsupported.
- PRAW helper objects that are both callable and stateful are represented by
  callable domain objects or client-bound TypeScript classes.
- Models retain unrecognized response fields through `raw` and `get()` so Reddit
  response additions do not require immediate type changes.
- Media inputs are snapshotted into replayable byte sources rather than Python
  file objects.

## How adaptations affect parity

An adaptation explains interface or runtime form; it does not lower or raise an
outcome status. The outcome is still supported, partial, or planned according to
its stated boundary and evidence.

Adaptation references are narrow. For example, asynchronous listings do not
imply that every PRAW listing helper exists, and exporting an adapted class name
does not imply that all behavior on the corresponding PRAW class is present.
During the schema-v2 transition, existing `adapted` ledger entries should be
split conceptually into an outcome status and a reference to the relevant rule
above.

Differences that change the user-visible result, omit a required path, or weaken
error and state semantics are limitations, not adaptations. They must be shown
as partial or planned outcomes.
