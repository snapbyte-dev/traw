# TypeScript adaptations

The parity baseline is PRAW 8.0.3. Parity means equivalent Reddit capability,
validation, requests, responses, errors, pagination, and state transitions.

The following language adaptations are intentional:

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
- Models retain unrecognized response fields and expose them through `raw` and
  `get()` so Reddit response additions do not require immediate type changes.
- Media inputs are snapshotted into replayable byte sources rather than Python
  file objects.

An `adapted` ledger entry records only the capability described by that entry.
It does not imply that every method on the corresponding PRAW class is present.
