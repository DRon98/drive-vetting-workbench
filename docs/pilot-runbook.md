# One-folder pilot runbook

Use this runbook after the synthetic release checks pass. Do not use a real
Google token or Drive item during the rehearsal.

The real pilot cannot start until Buck gives explicit OAuth consent and names
one folder. Keep those two gates closed during development.

## Rehearse first

1. Install the workspace with `pnpm install --frozen-lockfile`.
2. Run `pnpm test:pilot-rehearsal`.
3. Open the retained Drive Lab review HTML from the test transcript.
4. Check the exported feedback packet.
5. Check [the synthetic scorecard](../examples/pilot-scorecard.json).

The test changes one fake item. It scans all two pages. It builds an offline
review. It exports and imports feedback without loss. Feedback does not grant
approval. A separate approval authorizes one rename. Dry-run makes zero writes.
Apply re-fetches and verifies the rename. The second apply makes zero writes.

The source release exposes `pilot preflight` and `pilot scorecard` through the
typed `@dvw/cli` command API. It does not install a global `dvw` binary. A host
passes a JSON input file to `runCli`. The scorecard command writes a new local
JSON artifact. It does not replace a different file.

## Follow the eight gates

Complete the gates in this order. Stop at the first failed gate.

1. **Fixture.** Run all synthetic and adversarial checks. Fix every failure.
2. **Drive Lab.** Change one fake item. Scan it. Review the offline HTML. Export
   and reimport feedback. Approve separately. Apply and verify in Drive Lab.
3. **Read-only.** After Buck consents, select one folder. Use the read scope.
   Report full visible coverage or name every gap.
4. **Decision.** Ask only unresolved material questions. Store each answer with
   its scope and provenance.
5. **Review.** Generate new offline HTML. Check the exact dry-run. Approve the
   final plan hash through the CLI.
6. **Canary.** Select at most five low-risk effective actions. Apply only those
   approved actions. Re-fetch and verify each result.
7. **Folder.** If the canary changed live evidence, scan and plan again. Get a
   new explicit approval. Apply the remaining approved plan. Run apply again.
   The second run must make zero writes.
8. **Expansion.** Fill the scorecard. Add another folder only when every safety
   threshold passes.

Do not delete, trash, move, or overwrite file bodies. Use only rename and
shortcut writes that appear in the approved plan.

## Run the offline preflight

Create a local JSON input for the current gate. Use only configuration metadata
during rehearsal. Do not open the token path and do not call Drive.

```json
{
  "approvalPresent": false,
  "canaryEffectiveActionCount": 0,
  "driveLabGatePassed": true,
  "fixtureGatePassed": true,
  "localTokenPath": null,
  "oauthConsentRecorded": false,
  "outputDirectory": "/new/local/pilot-output",
  "policyVersion": "paisano:1.0.0",
  "providerMode": "GOOGLE_DRIVE_REHEARSAL",
  "requestedGate": "READ_ONLY",
  "scanFresh": false,
  "selectedFolderId": null,
  "tokenReadAttempted": false
}
```

This input must return three blockers: one folder is required, OAuth consent is
required, and the later local token path is not configured. The result must also
report `providerAccessed: false` and `tokenRead: false`.

After Buck completes the real consent step, record only the selected folder ID
and the configured local token path in the input. Keep the token value out of
the scorecard, logs, review HTML, and feedback packet.

## Apply the canary

Use five or fewer effective actions. Prefer clear, reversible renames and
shortcut creation. Exclude protected, ambiguous, stale, colliding, or
unauthorized actions.

Stop if one write does not match its expected after-state. Keep the verified
receipts. Re-scan before any expansion. If the canary changed live evidence,
build a new plan and get a new approval for the remaining actions.

## Fill the scorecard

Record these observed counts. Do not replace them with estimates.

- Visible items, API pages, coverage gaps, and named coverage gaps.
- Total proposals, accepted unchanged, edited, rejected, and blocked.
- Questions asked and resolved questions reused.
- Write attempts, verified writes, no-ops, retries, and second-run writes.
- Feedback rounds, packet validation failures, supported fields exported and
  imported, offline network requests, and review minutes.
- Total operator minutes.

Keep safety thresholds separate from learning targets. Expansion requires zero
unapproved writes, 100% live verification, zero second-run writes, zero
ambiguous actions executed, zero feedback fields lost, and zero HTML network
requests. Scan coverage must be 100%, or every gap must be named.

Acceptance rate, question rate, effort reduction, and mechanical automation are
learning measures. They do not authorize a write.

## Measure the manual baseline

Use a small sample from the selected folder. Measure real operator time before
you estimate time saved.

| Field                                               | Entry                                                       |
| --------------------------------------------------- | ----------------------------------------------------------- |
| Sample item IDs                                     | Stable IDs only. Do not copy body content.                  |
| Sample item count                                   |                                                             |
| Manual start and end time                           |                                                             |
| Manual minutes                                      |                                                             |
| Pilot operator minutes                              |                                                             |
| Estimated manual minutes for the full visible scope | Manual minutes per sample item multiplied by visible items. |
| Estimated minutes saved                             | Estimated manual minutes minus pilot operator minutes.      |

Label the result as an estimate. Do not promise a fixed labor saving before the
real sample is measured.

## Stop conditions

Stop the pilot and print the next corrective action when one condition fails:

- The visible scan has an unnamed gap.
- An action lacks exact approval.
- The canary has more than five effective actions.
- A target is stale, protected, colliding, ambiguous, or unauthorized.
- A write is not verified from fresh live state.
- The second apply makes a write.
- Feedback loses one supported field.
- The review HTML makes one network request.

The offline rehearsal can prove the workflow. It cannot claim that Buck
consented, that a real folder was scanned, or that the real pilot is complete.
