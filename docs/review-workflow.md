# Offline review and feedback

The review artifact is a generated dossier, not an application server. It is one
HTML file with embedded styles, controller code, review data, glossary, source
ledger, receipts, and a restrictive content security policy.

## Review sequence

1. A complete scan publishes an evidence generation.
2. Policy and bounded reasoning produce typed proposals and material questions.
3. The renderer writes a new content-addressed HTML artifact.
4. The reviewer accepts, rejects, edits, or asks about each proposal.
5. The page copies or downloads a versioned feedback packet.
6. The CLI or a later HTML file validates the plan hash, round, IDs, values, and
   checksum.
7. The planner makes a new plan and a new review round.
8. A separate operator approval binds the final immutable plan hash.
9. Dry-run and whole-plan preflight complete before the first write.
10. Apply re-fetches, makes the smallest allowed mutation, re-fetches again, and
    stores a receipt.

Feedback cannot perform steps 8 through 10.

## Six tabs

- Overview: scope, coverage, blockers, and the next human action.
- Drive Map: current and proposed trees with focusable evidence nodes.
- Proposed Changes: before, after, reason, evidence, risk, and review controls.
- Questions: material decisions, evidence-backed defaults, and scope.
- Feedback Packet: copy, download, paste, file import, validation, and preview.
- Receipts and Sources: verified runs, glossary, claims, and source ledger.

The page supports keyboard tabs and nodes, narrow screens, print expansion, and
reduced motion. Browser tests open it through `file://`, record zero network
requests, and keep hostile markup inert.

## Packet trust boundary

The packet includes its schema version, artifact version, plan hash, scan
generation, policy version, review round, reviewer, answers, action reviews,
comments, export time, and checksum. Serialization is canonical and lossless.

Import rejects stale plans or rounds, invalid checksums, unknown or duplicate
action IDs, invalid choices, unsupported scopes, invalid names, injected markup,
executable-shaped nested data, and scalar coercion. Accepted, ignored, and
rejected fields remain visible.

Accept means “keep this proposal during replan.” It is not plan approval. Edit
and Ask remain review-required inputs until normal planning validates them.

## Recovery

Artifacts and ledgers are create-only or append-only. If apply stops, resume
first verifies every prior receipt and repeats whole-plan preflight for the
remaining actions. An already satisfied rename or shortcut becomes a verified
no-op. A replay cannot create a duplicate shortcut or repeat a rename.

Run the [synthetic quick start](quickstart.md) to inspect both rounds, the exact
feedback bytes, and the verified tree.
