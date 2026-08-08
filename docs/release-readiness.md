# Release readiness

## Decision

The source release is ready for the read-only one-folder pilot gate.

The real pilot is not complete and is not authorized. It can start only after
Buck gives explicit OAuth consent and names one folder. The first real step is a
read-only scan. No real token, credential, Drive item, or Buck file content was
used for this audit.

This decision covers the local-first source package and synthetic workflow. It
does not authorize delete, trash, destructive move, body overwrite, unattended
apply, a broader folder scope, or a model-controlled mutation.

## Fresh audit summary

The audit ran on 2026-08-08 with Node.js 24 and pnpm 9.15.4.

| Command                                                 | Observed result                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm fixtures:reset`                                   | Exit 0. All seven named scenarios returned their stable append-only reset hashes.                                                                                                                                                                                   |
| `pnpm verify`                                           | Exit 0. Formatting, lint, strict types, 196 unit tests, 57 runnable integration tests, 17 Vitest end-to-end tests, eight browser tests, 19 security tests, builds, SQLite, boundaries, and package checks passed. The opt-in Google sandbox test was the only skip. |
| `pnpm verify:package`                                   | Exit 0 inside the aggregate. The offline clean room installed from the frozen lock and completed the full synthetic review and verified apply loop.                                                                                                                 |
| `pnpm package:manifest:check`                           | Exit 0. The package contains 206 controlled files and 894,856 unpacked bytes. Tests, fixtures, task reports, generated artifacts, tokens, databases, logs, nested dependencies, and build metadata are excluded.                                                    |
| `pnpm verify:no-real-data`                              | Exit 0. The secret scan had no findings and the source/fixture/provider isolation check passed.                                                                                                                                                                     |
| `pnpm audit --audit-level high`                         | Exit 0. No known vulnerabilities were found.                                                                                                                                                                                                                        |
| `npm test` in `/Users/ronitdas/plans-and-presentations` | 57 of 58 passed. The sole `stacks the masthead in a narrow preview pane` failure is unchanged from the recorded baseline.                                                                                                                                           |

The package checks report known tool warnings only: Node's experimental SQLite
notice, a transitive `url.parse()` deprecation, and Playwright's
`NO_COLOR`/`FORCE_COLOR` notice. The prescribed commands exit with the results
above.

The first published GitHub run exposed a clean-checkout ordering defect that a
warm local workspace had hidden: lint and typecheck ran before workspace
declarations existed. The corrected aggregate builds once before both type-aware
checks. Its regression test requires that order. A detached checkout at commit
`349efbe735e13e42e4dd81891eeadd8b921d6e24` started with no dependencies or
generated declarations, installed from the frozen lockfile, and passed the exact
`pnpm verify` command without a manual prebuild.

## Goal Contract evidence

Each row maps one Completion Criterion to a fresh command and an inspected
contract, test, or artifact.

|   # | Completion Criterion                                                                         | Fresh evidence                                                                                                                                                                                    | Result                                                                                                                                                                                                                                                                           |
| --: | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Clean install and all quality gates                                                          | `pnpm verify`; the build-order regression; `pnpm verify:package`; a detached checkout using the documented `pnpm install --frozen-lockfile` path                                                  | Pass. The checkout began without dependencies or declarations. The exact aggregate built before lint and typecheck, then the clean room completed the quick start.                                                                                                               |
|   2 | Complete paginated scan with explicit gaps                                                   | `pnpm test:scan-integration` passed 3/3; `tests/integration/scan/scan-pipeline.test.ts` exercises all pages, denied/export gaps, cycles, and failed-generation isolation                          | Pass. The final-page item is present and gaps are typed records.                                                                                                                                                                                                                 |
|   3 | Disposable SQLite evidence index with stable IDs, relationships, and atomic generations      | `pnpm test:evidence-integration` passed; the aggregate passed 10 evidence-store unit cases                                                                                                        | Pass. Parent and shortcut edges use stable IDs. A fresh empty store can migrate and rebuild from a scan. The workbench has no cache-delete command.                                                                                                                              |
|   4 | Versioned Paisano policy pack                                                                | `pnpm --filter @dvw/policy-engine test` passed 11/11; `packs/paisano/pack.json` binds the taxonomy, naming, document type, entity, protected, archive, shortcut, and precedent sections by digest | Pass. Invalid bytes or a mismatched section fail closed.                                                                                                                                                                                                                         |
|   5 | Fully typed proposals with provenance and preconditions                                      | `pnpm test:planning` passed 26 package cases and one integration case                                                                                                                             | Pass. Plan hashes and action IDs bind type, stable target, reason, evidence, policy, scan, preconditions, and review state.                                                                                                                                                      |
|   6 | Only five version 1 actions and no destructive provider operation                            | Direct inspection of `packages/core/src/action-types.ts` and `packages/core/src/providers.ts`; `pnpm test:security` passed 19/19                                                                  | Pass. Actions are `KEEP`, `RENAME`, `CREATE_SHORTCUT`, `PRESERVE_ARCHIVE`, and `NEEDS_REVIEW`. Provider mutations are only `rename` and `createShortcut`. A forbidden-surface search returned no match.                                                                          |
|   7 | Separate live observations, declared context, human decisions, policy, and model suggestions | `pnpm test:evidence-integration`, `pnpm test:planning`, and `pnpm test:security`                                                                                                                  | Pass. Source kinds stay distinct and conflicts create blockers instead of silent precedence.                                                                                                                                                                                     |
|   8 | Scoped, provenance-bearing question memory without repeated resolved questions               | `pnpm test:decisions` passed 11 package cases and one integration case                                                                                                                            | Pass. Relevant scoped precedents are reused. Unrelated answers do not leak across scope.                                                                                                                                                                                         |
|   9 | Provider-neutral, bounded, cancellable model reasoning with no write access                  | `pnpm test:reasoning` passed 19 package cases and one integration case                                                                                                                            | Pass. Schema, token/run budgets, cancellation, invalid output, and provider-neutral adapters fail closed. No mutation provider enters the reasoner.                                                                                                                              |
|  10 | Read-only MCP inspection for Claude and GPT                                                  | `pnpm test:mcp` passed 2/2; direct inspection of `apps/mcp-server/src/index.ts`                                                                                                                   | Pass. Exactly eight tools expose inventory, items, search, relations, coverage, proposals, questions, and receipts. Every tool has `readOnlyHint: true` and `destructiveHint: false`; a fake `delete_file` call is rejected.                                                     |
|  11 | Deterministic, sandboxed Drive Lab with provider parity                                      | `pnpm test:lab` passed 17 package cases and two integration cases; `pnpm fixtures:reset` returned seven stable hashes                                                                             | Pass. Pagination, content, permissions, shortcuts, stale state, injected failures, snapshot, diff, and append-only reset are covered. Traversal and symlink escape fail closed.                                                                                                  |
|  12 | One self-contained, keyboard-operable review HTML                                            | `pnpm review:browser-check` passed 5/5; the generated fixture uses a `file://` URL and restrictive CSP                                                                                            | Pass. The artifact contains the map, evidence, questions, action review controls, comments, and no server dependency.                                                                                                                                                            |
|  13 | Copy/download feedback and lossless import into hosts or later HTML                          | `pnpm test:feedback` passed 11 package and five integration cases; `pnpm test:feedback-browser` passed 3/3                                                                                        | Pass. Copy fallback, download, file import, pasted JSON, CLI import, and regenerated HTML preserve every supported field.                                                                                                                                                        |
|  14 | Untrusted feedback bound to plan hash and review round                                       | The focused feedback suites above; hostile cases cover checksum, stale plan, unknown action, invalid value, markup, executable text, and round mismatch                                           | Pass. Feedback can request a plan but returns `approvalGranted: false` and cannot execute.                                                                                                                                                                                       |
|  15 | Editorial, understandable, accessible review design                                          | `pnpm review:browser-check`; `docs/design-system.md`; `artifacts/local/review-browser/accessibility.json`                                                                                         | Pass. Six tabs were audited with zero violations. Editorial styling, category color, taxonomy, claim/evidence captions, source ledger, glossary, responsive layout, print, and reduced motion are present.                                                                       |
|  16 | Full browser matrix and zero network                                                         | `pnpm review:browser-check` and `pnpm test:feedback-browser`; `artifacts/local/review-browser/zero-network.json`; `artifacts/local/feedback-browser/zero-network.json`                            | Pass. Hero, six tabs, default/focused map, feedback editor, keyboard, desktop, mobile, print, reduced motion, and injection states are covered. The audit produced 19 images plus one print PDF and recorded zero remote requests.                                               |
|  17 | Immutable approval and whole-plan live preflight                                             | `pnpm test:preflight` passed four approval and 11 integration cases                                                                                                                               | Pass. Hash, expiry, stale, collision, protected, ambiguous, unauthorized, missing, and changed-live-state conditions block before the first write.                                                                                                                               |
|  18 | Exact zero-write dry-run                                                                     | The preflight suite and `tests/e2e/human-loop.test.ts` inside `pnpm verify`                                                                                                                       | Pass. The ordered operations are returned and provider write count stays zero.                                                                                                                                                                                                   |
|  19 | Smallest write, live re-fetch, verified no-op, and redacted append-only receipt              | `pnpm test:resume` passed four execution and four integration cases; `pnpm test:security` passed redaction boundaries                                                                             | Pass. Rename and shortcut are the only writes. Each outcome is re-fetched before a verified receipt is stored.                                                                                                                                                                   |
|  20 | Safe partial resume and idempotent second apply                                              | `pnpm test:resume`; 17/17 aggregate E2E including the human loop and pilot rehearsal                                                                                                              | Pass. Prior receipts are re-verified, remaining preflight is repeated, and second apply makes zero repeated renames or duplicate shortcuts.                                                                                                                                      |
|  21 | No Buck data, credentials, tokens, private entities, or copied upstream source               | `pnpm verify:no-real-data`, `pnpm scan:secrets`, `pnpm test:security`, and package manifest inspection                                                                                            | Pass. Only synthetic public fixtures are present. Concept attribution records independent use without copied source.                                                                                                                                                             |
|  22 | Complete open-source package and release evidence                                            | `pnpm docs:check` passed 16 Markdown files after this report; `pnpm licenses:check`; `pnpm package:manifest:check`; `npm pack --dry-run --json`                                                   | Pass. Apache-2.0 license, notice, contribution/security policy, quick start, policy/provider/MCP guides, threat model, architecture, pilot runbook, scorecard, and release evidence are controlled package files.                                                                |
|  23 | Fixture-backed pilot scorecard and closed real gate                                          | `pnpm test:pilot-rehearsal` passed six reporting and three E2E cases; `examples/pilot-scorecard.json`                                                                                             | Pass. Coverage, acceptance, question rate, blocked actions, write verification, idempotency, feedback, offline requests, and measured time estimate are present. Google rehearsal reads no token and selects no provider. Real access still needs Buck's consent and one folder. |

## Boundary inspection

### Mutation surface

The public action list is defined once in `packages/core/src/action-types.ts`.
The public provider method lists are defined once in
`packages/core/src/providers.ts`.

- Read methods: `listItems`, `getItem`, and `exportItem`.
- Mutation methods: `rename` and `createShortcut`.
- There is no delete, trash, move, body-write, shell, or credential method.

The Google adapter's executable calls remain name-only `files.update` and
shortcut-only `files.create`. Mutation requests are not retried automatically.

### MCP surface

`apps/mcp-server/src/index.ts` registers these tools only:

- `inventory_summary`
- `get_item`
- `search_items`
- `trace_relations`
- `get_coverage`
- `explain_proposal`
- `list_unresolved_questions`
- `list_run_receipts`

Each result is bounded to 128 KiB. Untrusted Drive text remains data. It cannot
change the tool list or invoke a mutation.

### Credentials and real-provider gate

`packages/drive-google/src/oauth.ts` resolves tokens outside the workspace. It
uses separate `metadata`, `content`, and `apply` files. The directory must use
mode `0700`; token files must use `0600`; writes are create-only. Traversal,
symlink escape, broad permissions, wrong mode, and scope mismatch fail closed.

The optional Google sandbox case remains skipped. This is intentional because
the audit had no Buck consent, selected folder, credential, or real Drive data.

### Browser evidence

Fresh ignored local evidence is under `artifacts/local/review-browser/` and
`artifacts/local/feedback-browser/`. It is not packaged.

- `accessibility.json`: six audited tabs, zero violations.
- `zero-network.json`: zero remote requests.
- Desktop: hero, all six tabs, default and focused maps, and edited feedback.
- Mobile: all six tabs.
- Print and reduced-motion captures, a print PDF, and an inert-injection
  capture.
- Feedback: valid round trip, regenerated round trip, blocked injection, and
  zero remote requests.

## Known non-blockers

- The parent `plans-and-presentations` baseline remains 57/58. This repository
  did not change that parent source.
- The local codebase knowledge-graph service returned `Transport closed` during
  final development. It is not a runtime or package dependency. Source and
  executable tests supplied the audit evidence.
- The Google sandbox test remains opt-in and skipped. Running it before the
  OAuth-and-one-folder gate would violate the release contract.

## Pilot handoff

The build is ready for Buck to decide whether to open the read-only gate. The
operator still needs exactly two inputs:

1. Buck's explicit OAuth consent.
2. One selected folder ID.

After those inputs exist, follow
[the one-folder pilot runbook](pilot-runbook.md). Do not start with write scope.
Do not expand beyond the selected folder. Do not apply a canary until a fresh
scan, resolved questions, regenerated offline review, exact dry-run, and
separate final-plan approval all pass.
