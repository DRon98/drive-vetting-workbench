# Architecture

Drive Vetting Workbench separates evidence, decisions, review, and execution so
no model output or review-page interaction can become a provider write.

## Four planes

| Plane     | Responsibility                                      | Write rule                                  |
| --------- | --------------------------------------------------- | ------------------------------------------- |
| Evidence  | Scan all pages, extract bounded evidence, index it. | Provider read-only; publish atomically.     |
| Decision  | Apply policy, decisions, and bounded reasoning.     | Local plan and decision artifacts only.     |
| Review    | Render offline HTML and import feedback.            | Local create-only artifacts; no approval.   |
| Execution | Approve, preflight, apply, receipt, resume, verify. | Only approved rename or shortcut mutations. |

Drive Lab implements the provider contracts below all four planes. The Google
adapter remains behind the same interfaces.

## Data flow

1. A read provider returns `ObservedItem` records keyed by stable provider ID.
2. The scanner stages one generation, follows all page tokens, records gaps and
   relations, then atomically publishes complete coverage.
3. Evidence bundles link every fact and policy match to a source locator.
4. Policy, scoped decisions, and a bounded model run tree produce candidates.
5. The planner emits only the five action types and hashes canonical
   authorization fields.
6. The review renderer embeds the plan and minimized evidence into one HTML
   file.
7. Feedback validates against its plan hash and round, then requests a replan.
8. Approval binds an operator to the final plan hash and expiry.
9. Preflight re-fetches the complete plan before any write.
10. The executor re-fetches each target, performs the smallest mutation,
    re-fetches the result, and appends a redacted receipt.

## Sources of truth

Live provider state outranks compatible approved human decisions. Decisions
outrank the versioned policy pack. Policy outranks declared context. Model
suggestions are last and advisory. A contradiction creates a blocker rather than
silently changing precedence.

## Package boundaries

- `@dvw/core` defines schemas, state machines, records, and provider interfaces.
- `@dvw/evidence-store-sqlite` owns disposable generations, relations,
  decisions, and execution ledger migrations.
- `@dvw/scanner` accepts `ReadProvider` only.
- `@dvw/policy-engine`, `@dvw/evidence-builder`, `@dvw/reasoning`, and
  `@dvw/change-planner` own deterministic proposal construction.
- `@dvw/review-artifact` and `@dvw/feedback` own the offline human boundary.
- `@dvw/execution` is the only package that receives both the approved plan and
  a mutation provider.
- `@dvw/query-service` stays transport-independent; `@dvw/mcp-server` adapts it
  to read-only MCP.

## Rebuild and recovery

The evidence database can be removed by the operator outside the workbench and
rebuilt from Drive. Runtime code does not expose a delete operation. Scan
generations publish atomically, so a failed generation cannot replace the last
active snapshot.

Execution events and receipts are append-only. Resume verifies prior actions and
repeats whole-plan preflight. An already satisfied action is a verified no-op.
Completion requires live after-state evidence for every effective action.

## Design acknowledgements

The staged local relationship index and compact-query approach were informed by
[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp). The
coordinator, bounded analyst branches, synthesizer, budgets, cancellation, and
event tree were informed by [pi-rlm](https://github.com/manojlds/pi-rlm). This
repository implements narrower typed contracts independently and includes no
source or runtime dependency from either project.

See the [threat model](threat-model.md), [provider guide](provider-guide.md),
and [review workflow](review-workflow.md) for boundary details.
