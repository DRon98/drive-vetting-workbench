# Drive Vetting Workbench: Final End Report

## Repository

This is a standalone Git repository at:

`/Users/ronitdas/drive-vetting-workbench`

It is not part of the plans-and-presentations repository. That repository is now
a read-only design reference.

## Product decision

Build a local-first, open-source tool that helps Buck review and improve Google
Drive with Claude, GPT, an offline HTML review page, or a human-operated command
line.

Version 1:

1. Inspect Drive or a safe simulated Drive.
2. Build a complete evidence index.
3. Apply the Hotel Paisano rules.
4. Ask only material questions.
5. Generate a rich review HTML.
6. Import Buck's structured feedback.
7. Build a final typed plan.
8. Wait for explicit CLI approval.
9. Apply only approved renames and shortcuts.
10. Re-fetch Drive and verify every result.

The tool will not delete files, move originals, edit file bodies, or give a
model or HTML page direct write access.

## What this unblocks

Buck does not need to expose Drive before development starts. Drive Lab provides
a small fake filesystem that exercises the real planner and executor contracts.

Before OAuth exists, a person can:

1. Open a messy Hotel Paisano-style fake filesystem.
2. Rename a fake file or change its permission.
3. Run the real scanner and planner.
4. Open the generated review HTML.
5. Review the filesystem map and proposed before-and-after changes.
6. Add decisions, edits, and comments.
7. Copy the feedback packet into Claude, GPT, the CLI, or another review HTML.
8. Rebuild the plan.
9. Approve and apply it to the fake filesystem.
10. Inspect the verified tree diff and receipts.

When Buck grants one-folder access, the same workflow switches from Drive Lab to
the Google Drive provider.

The main unblock is trust. Buck can see what the tool observed, what it
inferred, what it proposes, what he changed during review, and what the provider
shows after execution.

## System shape

| Part      | Job                                                                             | Result                                    |
| --------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| Evidence  | Scan Drive and build a local SQLite relationship index.                         | Complete visible inventory or named gaps. |
| Decision  | Apply policy, use bounded model analysis, and collect scoped human answers.     | Typed, evidence-backed change plan.       |
| Review    | Render a self-contained HTML dossier and exchange a plan-bound feedback packet. | Rich review without a server or account.  |
| Execution | Validate approval, apply the smallest write, and verify provider state.         | Append-only receipts and safe resume.     |

Drive Lab implements the same read and mutation provider interfaces as Google
Drive. Planner code must not branch on the provider name.

Claude and GPT use read-only MCP tools. The review HTML is also read-only. The
human-operated CLI owns final approval and apply.

## Buck review HTML

The selected frontend is a generated single HTML file. It opens locally and
makes no network request.

It includes:

- A source and version masthead
- A plain-language hero with the next decision
- A measured facts strip
- Accessible tabs
- A current and proposed filesystem map
- Before-and-after action reviews
- Evidence, risk, and source disclosures
- Material question packets
- Action-level and global comments
- Feedback copy, download, paste, import, and validation
- Prior receipts, glossary, and source ledger

Buck can mark each proposal `Accept`, `Reject`, `Edit`, or `Ask`. He can propose
a replacement name and add context.

The page exports one versioned feedback packet. The packet contains the plan
hash, review round, action IDs, decisions, proposed edits, and comments. Buck
can paste it into Claude, GPT, `dvw feedback import`, or the import box in a
later review HTML.

Feedback is not approval. A changed proposal creates a new plan hash. Buck
approves the final hash through the CLI.

## Design and understandability

The review artifact adapts the field-guide system from plans-and-presentations:

- Warm paper background and near-black ink
- Serif display type, humanist sans body type, and mono metadata
- Fixed category colors instead of decorative color
- Taxonomy pills reused across maps, reviews, and status labels
- A detail panel for every focusable filesystem node
- Claim captions and evidence receipts
- Inline glossary terms with source locators
- A source ledger and exact snapshot versions
- Keyboard navigation, focus styles, responsive layouts, and print support
- Purposeful motion with a reduced-motion mode
- ASD-STE100-style body copy

The page will not use glowing gradients, glass effects, a dark dashboard, or
repeated generic card grids.

## Drive Lab

Drive Lab is more than a unit-test mock. It is a persistent and human-editable
mini filesystem inside one checked sandbox directory.

It models:

- Stable file and folder IDs
- Mutable names and parents
- Shortcuts and cycles
- Permissions and protected items
- Paginated results
- Content snippets and fingerprints
- Same-size files with different content
- Stale changes after approval
- Rate limits and partial failures
- Wrong after-state responses
- Deterministic reset, snapshot, and diff

Named scenarios cover clean, messy Paisano, pagination, protected archive,
shortcut cycle, stale approval, and partial failure cases.

The lab refuses path traversal, symlink escape, and real Google provider access.

## Important safety choices

- Stable Google Drive IDs are identity. Names and paths can change.
- Drive is the source of current state.
- SQLite is a rebuildable evidence cache.
- The policy pack stores desired naming and organization rules.
- An approved plan hash is the only write authorization.
- Reorganization uses shortcuts. Originals stay in place.
- Bookkeeping Handoff can create dated batch shortcuts.
- Protected Data Room items and meaningful archives block automatic changes.
- Invalid model output, invalid feedback, and unresolved contradictions fail
  closed.
- Generated HTML escapes all Drive and feedback data and uses a restrictive
  content security policy.

The codebase-memory-mcp work informs the staged local graph, coverage checks,
and compact queries. The pi-rlm work informs bounded analysis branches, budgets,
cancellation, and run evidence. Neither repository is a required runtime
dependency.

## Version 1 scope

Allowed outcomes:

- `KEEP`
- `RENAME`
- `CREATE_SHORTCUT`
- `PRESERVE_ARCHIVE`
- `NEEDS_REVIEW`

Excluded from version 1:

- Delete or trash
- Destructive move
- File-body overwrite
- Unattended recurring execution
- Model-controlled approval
- HTML-controlled approval or Drive writes
- Hosted multi-user web service
- Notion, Box, Dropbox, or SharePoint adapters
- Embeddings or a remote graph database

## Delivery sequence

The canonical task plan contains 25 verification-bound tasks.

1. Create the TypeScript workspace and shared contracts.
2. Build the policy pack, provider contracts, and SQLite index.
3. Integrate the read-only scanner and MCP queries.
4. Add evidence bundles, bounded reasoning, decision memory, and typed plans.
5. Build the read and planning CLI.
6. Build Drive Lab and prove human interaction with the real planner path.
7. Generate the offline Buck review HTML.
8. Complete feedback export, paste, import, and replan.
9. Add approval, dry-run, execution, verification, and resume.
10. Connect the real Google Drive provider.
11. Run security, browser, and adversarial end-to-end checks.
12. Package the open-source project and rehearse the pilot.
13. Complete the release audit.

The dependency graph, file ownership, acceptance criteria, commands, and runner
handoffs are in [TASK-PLAN.md](./TASK-PLAN.md).

## Pilot path

The rollout uses eight gates:

1. Synthetic fixture proof
2. Human-operated Drive Lab and HTML feedback proof
3. Read-only scan of one real folder
4. Buck decision round
5. Regenerated HTML and exact dry-run approval
6. Five-action canary
7. Remaining approved folder plan
8. Expansion only after the scorecard passes

Safety thresholds are strict:

- Zero unapproved writes
- Zero ambiguous actions executed
- Every visible gap named
- Every successful write verified in provider state
- Zero repeated writes on the second apply
- Zero feedback fields lost in export and import
- Zero network requests from the generated HTML

The learning targets remain hypotheses:

- At least 70 percent of items classified without a Buck question after the
  first calibration folder
- At least 80 percent of proposals accepted without edit before expansion
- 80 to 95 percent of mechanical rename and shortcut work automated
- 50 to 70 percent less direct Buck effort after calibration

The pilot must measure these targets. They are not current results.

## Current state

- The repository is at the corrected standalone path.
- The canonical task plan includes Drive Lab, the offline review HTML, and
  feedback round-trip.
- The product is implemented and the full baseline-aware release audit passes.
- The source release is ready for the read-only one-folder pilot gate.
- No Buck Drive credential or real Buck data is present.
- The only external inputs expected for the real pilot are Buck's OAuth consent
  and one selected folder.

## Verification handoff

For future implementation changes, start from the Goal Contract and reconcile
the execution ledger with the current workspace before editing:

```text
/goal Implement the outcome defined in /Users/ronitdas/drive-vetting-workbench/TASK-PLAN.md.
```
