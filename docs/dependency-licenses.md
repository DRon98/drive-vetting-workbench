# Dependency license review

The project is Apache-2.0. Dependencies are installed from the committed
`pnpm-lock.yaml`; no dependency source or `node_modules` directory is included
in the source package.

## Automated policy

Run:

```bash
pnpm licenses:check
```

The command executes `pnpm licenses list --json` and fails if the lock resolves
a license class outside the reviewed set. On 2026-08-08, the complete runtime
and development tree reported 237 package entries:

| SPDX or reported class | Entries | Review note                                    |
| ---------------------- | ------: | ---------------------------------------------- |
| MIT                    |     181 | Permissive.                                    |
| Apache-2.0             |      23 | Permissive with notice and patent terms.       |
| ISC                    |      14 | Permissive.                                    |
| BSD-2-Clause           |       6 | Permissive.                                    |
| BlueOak-1.0.0          |       5 | Permissive.                                    |
| BSD-3-Clause           |       4 | Permissive with non-endorsement term.          |
| MPL-2.0                |       2 | File-level copyleft; axe test tooling only.    |
| Python-2.0             |       1 | `argparse`; permissive PSF license.            |
| BSD                    |       1 | `url-template`; upstream-reported BSD license. |

The counts describe resolved entries, not unique projects. MPL-2.0 packages are
development-only accessibility tooling and are not copied into the generated
review HTML or source archive.

## Review rule

Any new license class fails the gate. A maintainer must inspect the upstream
license and distribution obligations, update this document and the machine
allowlist, and run the package manifest check. Unknown, missing, proprietary,
strong-copyleft, or source-available-only terms are not accepted by default.

The package audit is separate from vulnerability and secret checks:

```bash
pnpm scan:secrets
```

Run the complete package gate before release:

```bash
pnpm verify:package
```
