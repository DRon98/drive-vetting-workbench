# Drive Vetting Workbench

Drive Vetting Workbench is a local-first review and execution system for one
Google Drive folder. It inventories evidence, applies a versioned policy,
creates a self-contained review file, imports lossless human feedback, requires
separate approval, and verifies each permitted write.

Version 1 can only keep an item, rename it, create a shortcut, preserve an
archive, or send it for review. It has no delete, trash, file-body update, or
destructive move operation.

## Start with synthetic data

Use Node.js 24 and pnpm 9.15. Install a clean checkout with one command:

```bash
pnpm install --frozen-lockfile
```

Run the complete credential-free example:

```bash
pnpm quickstart:lab
```

The command builds the workspace and creates a new append-only output directory.
Its `QUICKSTART_RESULT` line names the offline review HTML, exported feedback
packet, verified tree, immutable plan hash, mutation count, and verification
state. It proves all of these properties:

- the scanner reads all four synthetic items across two pages;
- feedback survives export, fenced paste, validation, and replan without loss;
- feedback does not grant approval;
- the review file contains its assets and makes no network call;
- dry-run makes zero writes;
- separate approval authorizes one verified rename; and
- replay makes zero additional mutations.

Open the reported HTML path directly in a browser. No server is necessary. The
page can copy or download feedback and can import a packet from a later review
round. See the [quick start](docs/quickstart.md) for the artifact walkthrough.

The repository currently ships a source workspace and an executable synthetic
example. The typed CLI command surface is available to workspace integrations,
but there is not yet a globally installed `dvw` binary. The documentation uses
only commands that exist in the root package.

## Safety model

- Drive Lab is the default development and demonstration provider.
- The SQLite evidence index is a disposable cache. Drive remains the source of
  current item state.
- Models can suggest actions, but cannot approve a plan or access a mutation
  provider.
- Feedback is untrusted input. It can request a new plan but cannot approve or
  execute one.
- Apply requires a separate approval artifact bound to the final plan hash.
- Preflight checks the whole plan before the first write. Every accepted write
  is re-fetched and recorded in an append-only receipt.
- Real Google access remains behind the pilot gate. The required suite uses no
  credential and contacts no Drive account.

Read the [architecture](docs/architecture.md),
[threat model](docs/threat-model.md), and [security policy](SECURITY.md) before
connecting a provider.

## Guides

- [Drive Lab](docs/drive-lab.md)
- [Offline review and feedback](docs/review-workflow.md)
- [Policy packs](docs/policy-packs.md)
- [Provider extension](docs/provider-guide.md)
- [MCP hosts](docs/mcp-hosts.md)
- [One-folder pilot](docs/pilot-runbook.md)
- [Design system](docs/design-system.md)
- [Dependency licenses](docs/dependency-licenses.md)

## Verify the checkout

Install Chromium once if the local Playwright cache is empty:

```bash
pnpm exec playwright install chromium
```

Then run the complete baseline:

```bash
pnpm verify
```

The aggregate includes formatting, lint, strict types, unit, integration,
adversarial E2E, offline browser, security, clean-room quick-start, license,
documentation, and package-manifest checks. The optional Google sandbox test is
skipped unless an operator explicitly opens that gate.

## Project map

- `apps/cli`: typed command routing and operator output contracts.
- `apps/mcp-server`: eight bounded read-only MCP tools over a local evidence
  database.
- `packages/drive-simulator`: Drive Lab and its sandboxed fake provider.
- `packages/review-artifact`: the single-file offline dossier.
- `packages/feedback`: packet checksum, import, and replan contracts.
- `packages/execution`: approval, preflight, apply, receipt, resume, and verify.
- `packs/paisano`: the versioned sample policy pack.

## License and contributions

The project is licensed under Apache-2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE). Contributions are welcome under the safety and verification
rules in [CONTRIBUTING.md](CONTRIBUTING.md).
