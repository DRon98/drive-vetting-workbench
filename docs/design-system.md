# Drive Vetting Review Dossier Design System

## Purpose

The review artifact helps one person understand and review one evidence-backed
Drive plan. It is an offline case file, not a dashboard. A reader must be able
to explain the current state, proposed state, blockers, and next human action
without opening another tool.

The shipped artifact is one HTML file. It embeds its CSS, controller, review
data, and provenance. It does not load a font, script, image, analytics call, or
other network resource.

## Visual direction

The aesthetic is an archival editorial dossier:

- warm paper base and near-black ink;
- Charter-class serif for display text;
- Avenir-class humanist sans for body text;
- system mono for identifiers and source locators;
- hairline ledger rules instead of repeated cards;
- deliberate density with generous section margins;
- no decorative gradients, glass effects, glow, or generic product chrome.

The filesystem map is the signature figure. It uses rounded paper nodes, visible
parent depth, category rails, and a paired evidence panel. Focusing a node dims
unrelated nodes and opens its current state, proposed state, policy, evidence,
risk, and source locators.

## Color is meaning

| Meaning           | Token | Use                                                        |
| ----------------- | ----- | ---------------------------------------------------------- |
| Observed evidence | Blue  | Current Drive state, facts, source evidence                |
| Policy            | Lime  | Rules, reason codes, taxonomy, expected constraints        |
| Human review      | Amber | Pending decisions, questions, action review controls       |
| Safe or verified  | Mint  | Keep states, complete coverage, verified prior receipts    |
| Blocker or risk   | Rose  | Blocked actions, permission gaps, conflicts, rejected data |

Every color-coded figure includes a text legend. Color is never the only state
signal. Pills, labels, icons, and plain text repeat the meaning.

## Page anatomy

1. A skip link moves focus to the review content.
2. The masthead names artifact version, plan hash, scan generation, policy
   version, review round, and source snapshot.
3. The hero states the next human action in one sentence.
4. Four linked facts show item count, proposal count, effective write count, and
   blocker count. Each fact links to its evidence disclosure.
5. A sticky ARIA tablist exposes Overview, Drive Map, Proposed Changes,
   Questions, Feedback Packet, and Receipts and Sources.
6. A source ledger and glossary close the dossier.

## Interaction contract

- Arrow Left and Arrow Right move between tabs. Home and End jump to the first
  and last tab.
- A pointer or Enter and Space can focus every filesystem node.
- The map focus selector and node controls update the same polite live region.
- Action controls use pressed-state buttons for Accept, Reject, Edit, and Ask.
- Edit reveals a text field. Comments remain plain text.
- Question choices are native radio controls. Scope is a native select.
- Glossary buttons open a non-modal definition card. Escape closes it.
- The feedback tab previews local review state. T15 owns packet validation,
  checksum, copy, download, paste, and import. This artifact cannot approve or
  execute a plan.

## Responsive and print behavior

Desktop uses a map and evidence rail. Below 56 rem, the rail stacks below the
map. Below 40 rem, the visual map becomes a readable ordered tree with the same
focus controls and labels. Action rows, questions, facts, and source entries
stack into one column.

Print hides interactive navigation and controls. It expands every tab and every
node detail. It preserves before and after labels, evidence disclosures,
questions, comments, sources, and glossary definitions. Page breaks avoid
splitting one action review where practical.

## Motion

Motion explains sequence. The first view reveals facts and action rows in
reading order. The feedback return rule uses one slow dashed motion. No other
animation loops. Under `prefers-reduced-motion: reduce`, all content is visible
without animation and scrolling is immediate.

## Security and data handling

- The generator validates the complete input and the typed change plan.
- It escapes every Drive name, comment, evidence value, rule summary, and source
  locator before HTML output.
- Review data is embedded as inert JSON with HTML-significant characters
  encoded.
- Executable JavaScript is a fixed controller. It uses `textContent`, DOM
  attributes, and native controls. It does not use `innerHTML`, `eval`, dynamic
  script creation, remote URLs, or form submission.
- A content security policy defaults to no capability. It permits only the
  hashed embedded stylesheet and controller. Network, frames, objects, forms,
  and base URL changes remain disabled.
- Human review state is advisory. It cannot approve a plan or call a Drive
  provider.

## Provenance

This system adapts the explanation rules in the local `plans-and-presentations`
reference files. Their reusable ideas are copied into this standalone package as
design decisions, not runtime dependencies. The artifact source ledger cites the
plan, scan, policy, evidence locators, and generation input that support each
displayed claim.
