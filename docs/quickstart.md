# Quick start

This walkthrough uses only synthetic Drive Lab data. It needs no Google account,
OAuth client, token, network request, or private file.

## Prerequisites

- Node.js 24
- pnpm 9.15
- a local browser for opening the generated HTML

From a clean checkout, install once:

```bash
pnpm install --frozen-lockfile
```

## Run the complete loop

```bash
pnpm quickstart:lab
```

The command creates a new directory below `artifacts/local/quickstart`. It does
not reuse or clear an earlier run. Find the final line that starts with
`QUICKSTART_RESULT`.

The JSON record gives these paths and checks:

- `reviewArtifactPath`: a self-contained round-two HTML dossier;
- `feedbackPath`: the exact versioned feedback packet that survived import;
- `finalTreePath`: the verified Drive Lab tree after apply;
- `dryRunWriteCount`: always `0`;
- `appliedMutationCount`: `1` for the separately approved synthetic rename;
- `idempotentReplayMutationCount`: always `0`;
- `networkCallCount`: always `0`; and
- `state`: `Completed` only after a live fake-provider re-fetch.

Open `reviewArtifactPath` as a local file. Inspect all six tabs. The Feedback
Packet tab can copy or download the packet. It can also import a raw packet, a
JSON file, or a fenced JSON block. Imported feedback remains a request to
replan; it never becomes approval.

Open `feedbackPath` in a text editor to inspect the exact packet bytes. Open
`finalTreePath` to compare the verified item name with the proposed after-state.
The output directory also retains the Drive Lab manifest, evidence database,
execution ledger, and both review rounds.

## Run the focused demonstrations

Use the smaller append-only Drive Lab command demonstration:

```bash
pnpm lab:demo
```

Build the canonical offline review fixture:

```bash
pnpm review:build:fixture
```

Prove the canonical feedback packet and regenerated HTML:

```bash
pnpm feedback:roundtrip:fixture
```

The root package currently exposes these development scripts rather than a
globally installed `dvw` executable. The typed CLI library still enforces the
same command, output, approval, and provider contracts used by the integration
suite.

## Verify the package path

The release gate copies the checkout into a new temporary directory, installs
from the locked local pnpm store, builds there, and runs the same quick start:

```bash
pnpm verify:cleanroom-quickstart
```

It never removes or moves a prior directory. The transcript prints the retained
clean-room path.

## Keep the real provider gated

Do not set `DVW_GOOGLE_SANDBOX=1` for this walkthrough. Real-provider work
starts only after an operator supplies a disposable synthetic Google account,
selects one folder, reviews the requested scope, and explicitly opens the pilot
gate. See the [provider guide](provider-guide.md) and
[threat model](threat-model.md) before that step.
