# Security policy

## Supported versions

This project is pre-release. Security fixes apply to the current default branch
only. Published release support will be documented when version 1 is tagged.

## Report a vulnerability

Use a private GitHub security advisory for the repository, or contact the
maintainer through the private channel listed on the repository profile. Do not
open a public issue for a suspected credential, authorization, path-boundary,
HTML injection, approval, or provider-mutation defect.

Include the affected version or commit, a minimal synthetic reproduction,
expected and observed behavior, and the security impact. Do not include Buck
data, Drive exports, item names, OAuth tokens, client credentials, private
entity data, or other third-party content. Replace all examples with synthetic
fixtures. Do not test against another person's Drive or account.

The maintainer will acknowledge the report through the same private channel,
validate it with synthetic data, coordinate a fix and disclosure, and publish
release evidence after verification. Response timing is best effort while the
project is pre-release.

## Security boundaries

- Version 1 permits `KEEP`, `RENAME`, `CREATE_SHORTCUT`, `PRESERVE_ARCHIVE`, and
  `NEEDS_REVIEW` only.
- There is no delete, trash, file-body write, or destructive move operation.
- Drive Lab must stay inside its selected canonical sandbox directory.
- Models and the MCP server are read-only. They cannot approve or execute.
- Feedback can request a new plan. It cannot approve or execute.
- A real write requires a current human approval for the immutable plan hash,
  exact operator confirmation, whole-plan live-state preflight, a separately
  selected execution provider, and verification after each write.

See [the threat model](docs/threat-model.md) for assets, trust boundaries,
controls, test mappings, and residual risk.

## Credential handling

Do not put tokens or client credentials in this repository. Store them only in
the documented local configuration directory. The Google provider checks the
canonical path and requires exclusive directory and file permissions. Use a read
profile for scan and review. Load the write profile only after valid human
approval and explicit apply confirmation.

If credentials might be exposed, stop the run. Revoke the OAuth grant, rotate
the affected client credential, remove the affected local token with normal
operator tooling, and repeat offline verification before authorizing again. The
workbench does not automate credential deletion.

## Required local checks

Run these checks before release and after any security-boundary change:

```sh
pnpm test:security
pnpm audit --audit-level high
pnpm scan:secrets
```

The secret scanner reports only the rule, path, location, and a one-way
fingerprint. It does not echo the matched value. For an intentional synthetic
fixture, add a same-line annotation in this exact form:

```text
dvw-secret-scan: allow RULE_ID - substantive reason
```

Do not annotate a real secret. Replace it, revoke it if necessary, and keep the
repository clean. Review every dependency and lockfile change even when the
advisory audit is green. A clean audit cannot detect unknown compromise.

## Disclosure scope

Useful reports include authorization bypass, OAuth scope escalation, token path
or permission failure, Drive Lab escape, review HTML code execution or network
access, feedback or approval bypass, plan-hash collision or canonicalization
error, MCP mutation exposure, destructive provider behavior, receipt mutation,
or credential leakage. General product suggestions and non-security bugs can use
the normal issue tracker when the repository publishes one.
