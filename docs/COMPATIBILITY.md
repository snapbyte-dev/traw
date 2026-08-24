# Compatibility

TRAW uses [PRAW 8.0.3](https://github.com/praw-dev/praw/tree/v8.0.3) as a pinned
behavioral reference. The goal is equivalent useful Reddit outcomes where the
languages permit them, not Python symbol identity or matching call shapes.

## Supported boundary

The public API is TypeScript-native:

- names are camel-cased and keyword arguments become options objects;
- network work returns promises, while listings and polling streams implement
  `AsyncIterable`;
- model references are synchronous and hydration is explicit through `load()` or
  `refresh()`;
- cancellation uses `AbortSignal`;
- domain helpers are class APIs, including `drafts.reference/list/create`,
  `announcements.list`, `live.reference`, `reddit.multireddits`, and
  `account.preferences.get/update`;
- the authenticated-user domain is `account`; there is no `user` alias; and
- public errors use TypeScript `*Error` names.

Focused local contract, behavioral, and protocol-mocking tests define the
supported boundaries. A neighboring PRAW method, an exported type, or a similar
name does not extend that support automatically.

## Evidence limits

Deterministic tests exercise request shapes, objectification, errors,
pagination, retries, cancellation, and state changes. Recorded or synthetic
transport interactions can validate protocol handling at the tested boundary.

Local, fixture-based, and mocked tests do not guarantee current interoperability
with live Reddit. Reddit controls its deployed endpoints, response schemas,
authorization policy, and rate limits. Applications must validate the workflows
and OAuth scopes they depend on against Reddit's current service and policies.

Evidence should be updated or removed when an API boundary, implementation,
fixture, or behavioral reference changes.
