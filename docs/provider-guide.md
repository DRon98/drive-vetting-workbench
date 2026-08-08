# Provider extension guide

Providers translate one storage system into stable observed items and two
explicit capability interfaces. Planning code depends on neither interface.
Scanning accepts only reads. Execution receives mutation capability only after
approval and preflight.

## Read interface

A read provider exposes:

- `listItems({ rootId, pageSize, pageToken, supportsAllDrives })`;
- `getItem(itemId)`; and
- `exportItem({ itemId, exportMimeType })`.

Return typed `ProviderResult` values. An observed item needs a stable provider
ID, mutable name, MIME type, parents, shortcut target, timestamps, trash state,
compact permissions, scan generation, and a content fingerprint when available.

Consume every non-null page token. Report denied, unsupported, incomplete, and
failed reads as coverage issues. Never convert an error into an empty page or an
absent item.

## Mutation interface

Version 1 has exactly two methods:

- `rename({ targetId, name, expectedModifiedTime })`; and
- `createShortcut({ targetId, parentId, name })`.

Do not add delete, trash, body update, copy, reparent, move, or arbitrary
request methods. A rename must check the live modification precondition. A
shortcut must name exactly one target and one destination parent.

The executor re-fetches before and after each mutation. A provider response is
not proof of success. Do not retry an ambiguous mutation automatically; let
verification and resume determine the live result.

## Error mapping

Map storage errors to `DENIED`, `NOT_FOUND`, `RATE_LIMITED`, `STALE_STATE`,
`UNSUPPORTED_EXPORT`, or `PROVIDER_FAILURE`. Set `retryable` only for safe reads
whose result is unambiguous. Redact raw response text before an issue, receipt,
or operator error is stored.

## Provider selector

Use separate selectors for read and execution capability. A metadata or content
authorization mode must not construct a mutation provider. Lab mode must resolve
only the selected sandbox and must not fall back to Google.

The minimal read-provider skeleton is in
[`examples/provider/read-provider.ts`](../examples/provider/read-provider.ts).

## Contract test checklist

- all pages and later-page items;
- stable IDs, parents, shortcut targets, and content fingerprints;
- denied and unsupported exports;
- incomplete search and malformed metadata;
- read retry limits and error mapping;
- Shared Drive flags when applicable;
- zero writes during scan, evidence, plan, review, and MCP use;
- stale rename precondition;
- exact shortcut request;
- no automatic mutation retry;
- re-fetch and redacted receipt verification; and
- parity with Drive Lab for the shared contract.

The Google adapter decision and scope split are recorded in
[`docs/adr/001-google-drive-provider.md`](adr/001-google-drive-provider.md).

## Later storage or knowledge-base adapters

A later adapter can implement the same read records, policy evaluation, plan,
approval, receipt, and verification contracts. It must define stable identity,
pagination, permissions, stale-state preconditions, and smallest permitted
writes. It cannot reuse path labels as identity or broaden the version 1 action
surface without a new contract and threat review.
