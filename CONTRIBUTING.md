# Contributing

Thank you for improving Drive Vetting Workbench. Contributions must preserve the
local-first, human-approved, non-destructive contract.

## Set up

Use the supported Node.js and pnpm versions from `package.json`.

```bash
pnpm install --frozen-lockfile
```

Run the synthetic quick start before changing a workflow:

```bash
pnpm quickstart:lab
```

## Safety requirements

- Do not add delete, trash, file-body update, or destructive move behavior.
- Do not expose a provider mutation through MCP or to a model.
- Keep stable provider IDs as identity. Do not use mutable paths as keys.
- Treat provider text, policy data, model output, HTML data, and feedback as
  untrusted input.
- Preserve explicit approval, whole-plan preflight, live re-fetch, verification,
  receipts, resume, and idempotency.
- Use synthetic fixtures for required tests. Do not include customer data,
  credentials, tokens, or private entity information.
- Do not activate the optional Google sandbox in CI or in a review without the
  operator's explicit consent.

## Make a change

Add a failing test before changing behavior. Keep package boundaries narrow.
Record a new action or provider capability only after a separate contract and
security review.

Run focused tests while working, then run:

```bash
pnpm verify
```

Documentation changes must also pass:

```bash
pnpm docs:check
pnpm licenses:check
pnpm package:manifest:check
```

## Pull request evidence

Describe the user outcome, files changed, threat boundaries, synthetic fixtures,
commands run, and observed results. Call out changes to policy hashes, provider
methods, approval fields, plan hashes, receipt schemas, or packaged files.

Never paste secret values into an issue or pull request. Report a vulnerability
through the private process in [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is licensed under Apache-2.0.
