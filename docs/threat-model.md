# Threat model

## Scope

This model covers Drive Vetting Workbench version 1. It covers the local CLI,
Drive Lab, Google Drive provider boundary, SQLite evidence cache, policy pack,
bounded reasoning adapter, read-only MCP server, review HTML, feedback packet,
approval artifact, and non-destructive executor.

The model assumes one trusted local operator and an uncompromised operating
system. It does not assume that Drive names, file text, policy files, model
output, feedback packets, review HTML inputs, page tokens, or provider errors
are safe. The repository and automated tests use synthetic data only. Real Buck
data and OAuth credentials remain outside this threat-model exercise and outside
the repository.

## Security properties

- Version 1 has no delete, trash, body-write, or destructive move operation.
- Models and MCP clients cannot mutate Drive or approve a plan.
- A human approval artifact authorizes only one immutable plan hash.
- Apply completes whole-plan preflight before the first write and verifies each
  accepted write before continuing.
- Drive Lab cannot access paths outside its canonical sandbox root.
- The review artifact is one offline file. It escapes untrusted data and makes
  no network request.
- Feedback is untrusted data. It can request replanning but cannot approve or
  execute a plan.
- Read and write OAuth profiles use separate exact scope sets and local token
  files with restrictive permissions.

## Assets and trust boundaries

| Asset                                     | Security need                                       | Boundary                                                             |
| ----------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| OAuth tokens and client configuration     | Confidentiality and least privilege                 | Local configuration directory to Google authorization and Drive APIs |
| Drive item metadata and exported snippets | Confidentiality and integrity                       | Drive or Drive Lab to the local evidence cache                       |
| Versioned policy pack                     | Integrity and provenance                            | Local files to the policy engine                                     |
| Model evidence and output                 | Integrity and non-authority                         | Reasoning adapter to an untrusted model provider                     |
| Review HTML and feedback packet           | Integrity, inert rendering, and lossless round-trip | Generator to browser, clipboard, file, CLI, or later review artifact |
| Change plan and approval                  | Immutability and authorization binding              | Planner to human approval to executor                                |
| Execution receipts                        | Integrity, append-only history, and redaction       | Executor to local SQLite ledger                                      |
| MCP responses                             | Confidentiality and read-only capability            | Local query service to Claude or GPT host                            |

The operator controls the local workspace, selected Drive Lab sandbox, policy
pack, provider mode, OAuth consent, final approval, and apply confirmation. The
following inputs stay untrusted even when they come from a selected folder: file
names, file bodies, comments, metadata, provider errors, model output, policy
text, HTML text, and imported feedback.

## Threat-to-control-to-test matrix

Impact and likelihood are qualitative pre-pilot estimates. Residual risk is the
risk that remains after the listed controls. The pilot must revisit these
ratings with fixture and operator evidence before any real folder is selected.

| Threat                           | Scenario                                                                                                      | Impact / likelihood | Controls                                                                  | Verification                                                                                             | Residual risk                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `THR_CLIPBOARD_PACKET_TAMPERING` | Clipboard or downloaded feedback is edited in transit.                                                        | High / Medium       | `CTRL_FEEDBACK_SCHEMA`, `CTRL_FEEDBACK_CONTEXT`                           | `tests/security/review-feedback-boundaries.test.ts`                                                      | A trusted operator can intentionally submit a different valid packet; it still cannot approve or execute.            |
| `THR_CSP_BYPASS`                 | Injected content attempts to execute code or contact a remote origin from the review file.                    | High / Low          | `CTRL_CSP_HASH`, `CTRL_OFFLINE_ARTIFACT_SCAN`                             | `tests/security/review-feedback-boundaries.test.ts`                                                      | Browser defects or extensions can bypass page policy; open the artifact in a maintained, clean browser profile.      |
| `THR_DEPENDENCY_COMPROMISE`      | A known vulnerable package enters the install graph.                                                          | High / Medium       | `CTRL_LOCKFILE`, `CTRL_DEPENDENCY_AUDIT`                                  | `pnpm audit --audit-level high`                                                                          | Audits do not find unknown or malicious-but-unreported releases; review lockfile changes.                            |
| `THR_DRIVE_LAB_PATH_ESCAPE`      | Traversal or a symlink reaches data outside the configured lab root.                                          | Critical / Medium   | `CTRL_LAB_CANONICAL_PATH`, `CTRL_LAB_SYMLINK_REJECTION`                   | `tests/security/provider-isolation.test.ts`                                                              | A compromised operating system can subvert filesystem guarantees.                                                    |
| `THR_HTML_SCRIPT_INJECTION`      | A name, comment, policy value, or feedback field contains executable markup.                                  | Critical / High     | `CTRL_HTML_ESCAPE`, `CTRL_CSP_HASH`                                       | `tests/security/review-feedback-boundaries.test.ts`                                                      | Browser implementation defects remain possible; the artifact is offline and contains no remote code.                 |
| `THR_LOG_LEAKAGE`                | Provider errors or receipts echo tokens, credentials, control characters, or excessive private text.          | High / Medium       | `CTRL_LOG_REDACTION`, `CTRL_SECRET_SCAN`                                  | `tests/security/redaction-boundaries.test.ts`, `tests/security/secret-scan.test.ts`, `pnpm scan:secrets` | Pattern redaction cannot identify every private phrase; logs remain local and bounded.                               |
| `THR_MALICIOUS_DRIVE_NAME`       | A Drive item name is rendered as markup or treated as an instruction.                                         | High / High         | `CTRL_HTML_ESCAPE`                                                        | `tests/security/review-feedback-boundaries.test.ts`                                                      | The operator can still be socially engineered by visible text; claim captions and source labels preserve provenance. |
| `THR_MALICIOUS_FILE_TEXT`        | File text tells a model or runtime to ignore policy or perform a write.                                       | Critical / High     | `CTRL_UNTRUSTED_EVIDENCE`, `CTRL_MODEL_NO_TOOLS`                          | `tests/security/injection-boundaries.test.ts`                                                            | A model can still classify badly; schema validation, bounded context, and human review prevent authority transfer.   |
| `THR_MCP_TOOL_CONFUSION`         | A host invokes an invented mutation tool or mistakes query output for authority.                              | Critical / Medium   | `CTRL_MCP_ALLOWLIST`, `CTRL_MCP_PACKAGE_BOUNDARY`                         | `tests/security/provider-isolation.test.ts`                                                              | A compromised host can misuse data it already received, but this server exposes no mutation capability.              |
| `THR_MODEL_OUTPUT_INJECTION`     | Model output contains an extra action, tool request, approval, or invalid shape.                              | Critical / High     | `CTRL_MODEL_SCHEMA`, `CTRL_MODEL_NO_TOOLS`                                | `tests/security/injection-boundaries.test.ts`                                                            | Valid but low-quality suggestions can remain; they require deterministic planning checks and human review.           |
| `THR_PLAN_TAMPERING`             | A plan changes after review while retaining an old approval.                                                  | Critical / Medium   | `CTRL_PLAN_CANONICAL_HASH`, `CTRL_APPROVAL_BINDING`                       | `tests/security/approval-policy-boundaries.test.ts`                                                      | A compromised local process could replace both artifacts; protect the operator account and workspace.                |
| `THR_POISONED_POLICY`            | A schema-valid or instruction-shaped policy edit changes decisions without review.                            | High / Medium       | `CTRL_POLICY_SCHEMA`, `CTRL_POLICY_CONSISTENCY`                           | `tests/security/injection-boundaries.test.ts`, `packages/policy-engine/src/policy-engine.test.ts`        | An authorized manifest update can still encode bad policy; review policy diffs and approvals.                        |
| `THR_SCOPE_ESCALATION`           | A read-only operation loads a write-scoped token or an invalid authorization mode.                            | Critical / Medium   | `CTRL_SCOPE_PROFILES`, `CTRL_AUTH_MODE_GUARD`                             | `tests/security/provider-isolation.test.ts`                                                              | Google account or OS compromise is outside the application boundary.                                                 |
| `THR_STALE_APPROVAL`             | An expired approval or one for another plan is applied.                                                       | Critical / Medium   | `CTRL_APPROVAL_EXPIRY`, `CTRL_APPROVAL_BINDING`                           | `tests/security/approval-policy-boundaries.test.ts`                                                      | Clock integrity depends on the local host; whole-plan live-state preflight adds an independent gate.                 |
| `THR_STALE_FEEDBACK`             | Feedback for another plan or review round is imported.                                                        | High / High         | `CTRL_FEEDBACK_SCHEMA`, `CTRL_FEEDBACK_CONTEXT`                           | `tests/security/review-feedback-boundaries.test.ts`                                                      | A valid current packet can contain poor human choices; replanning and a later approval remain separate.              |
| `THR_TOKEN_THEFT`                | OAuth material is committed, stored inside the workspace, followed through a symlink, or made group-readable. | Critical / Medium   | `CTRL_TOKEN_PERMISSIONS`, `CTRL_TOKEN_CANONICAL_PATH`, `CTRL_SECRET_SCAN` | `tests/security/provider-isolation.test.ts`, `tests/security/secret-scan.test.ts`, `pnpm scan:secrets`   | Malware with the operator's privileges can read local tokens; revoke consent after suspected compromise.             |

## Control catalog

Every mitigation has a control type and enforcement layer. Preventive controls
block unsafe state. Detective controls report drift or an unsafe artifact. The
operator response in `SECURITY.md` is corrective when a control reports a
problem.

| Control                      | Type       | Layer       | Enforcement                                                                   |
| ---------------------------- | ---------- | ----------- | ----------------------------------------------------------------------------- |
| `CTRL_APPROVAL_BINDING`      | Detective  | Application | Recomputes the plan and approval binding before execution.                    |
| `CTRL_APPROVAL_EXPIRY`       | Preventive | Application | Rejects approvals outside their validity window.                              |
| `CTRL_AUTH_MODE_GUARD`       | Detective  | Application | Rejects invalid runtime authorization modes at provider and token boundaries. |
| `CTRL_CSP_HASH`              | Preventive | Endpoint    | Restricts the offline artifact to its exact embedded script and local data.   |
| `CTRL_DEPENDENCY_AUDIT`      | Detective  | Process     | Runs the high-severity package advisory audit.                                |
| `CTRL_FEEDBACK_CONTEXT`      | Detective  | Application | Checks plan hash, review round, action IDs, and packet checksum.              |
| `CTRL_FEEDBACK_SCHEMA`       | Preventive | Application | Rejects unknown fields, invalid values, markup, and approval-shaped feedback. |
| `CTRL_HTML_ESCAPE`           | Preventive | Application | Encodes untrusted values for HTML and embedded JSON contexts.                 |
| `CTRL_LAB_CANONICAL_PATH`    | Preventive | Endpoint    | Resolves and checks every sandbox path against the canonical root.            |
| `CTRL_LAB_SYMLINK_REJECTION` | Detective  | Endpoint    | Refuses a scenario or state path that crosses a symlink boundary.             |
| `CTRL_LOCKFILE`              | Preventive | Process     | Pins the resolved dependency graph for reproducible installation.             |
| `CTRL_LOG_REDACTION`         | Preventive | Application | Normalizes, bounds, and redacts provider error and receipt text.              |
| `CTRL_MCP_ALLOWLIST`         | Preventive | Endpoint    | Registers only eight bounded read-only MCP tools.                             |
| `CTRL_MCP_PACKAGE_BOUNDARY`  | Detective  | Process     | Tests that MCP cannot import execution or Google mutation packages.           |
| `CTRL_MODEL_NO_TOOLS`        | Preventive | Endpoint    | Gives the reasoning provider no tools and no mutation authority.              |
| `CTRL_MODEL_SCHEMA`          | Preventive | Application | Strictly validates bounded model responses and fails closed.                  |
| `CTRL_OFFLINE_ARTIFACT_SCAN` | Detective  | Process     | Verifies the generated artifact contains no remote resource or network path.  |
| `CTRL_PLAN_CANONICAL_HASH`   | Preventive | Data        | Computes immutable authorization identity from canonical plan fields.         |
| `CTRL_POLICY_CONSISTENCY`    | Detective  | Application | Verifies exact section hashes and rejects contradictory policy rules.         |
| `CTRL_POLICY_SCHEMA`         | Preventive | Application | Strictly validates the manifest and every policy section.                     |
| `CTRL_SCOPE_PROFILES`        | Preventive | Endpoint    | Separates exact read and write OAuth scopes and token profiles.               |
| `CTRL_SECRET_SCAN`           | Detective  | Process     | Scans current source without printing matched secret values.                  |
| `CTRL_TOKEN_CANONICAL_PATH`  | Preventive | Data        | Keeps token material outside the workspace and rejects symlink aliases.       |
| `CTRL_TOKEN_PERMISSIONS`     | Preventive | Data        | Requires exclusive directory and file modes for token storage.                |
| `CTRL_UNTRUSTED_EVIDENCE`    | Preventive | Data        | Labels evidence as data and keeps it outside runtime instructions.            |

## Detection and response

Stop before apply when any schema, checksum, scope, path, approval, preflight,
secret, or mutation-isolation check fails. Preserve the failing synthetic
artifact when it contains no secret. Do not print or attach credentials. Revoke
suspected OAuth tokens, remove the affected local token file using normal
operator tooling, rotate any exposed client secret, and repeat the offline and
Drive Lab suites before another consent flow. The application itself has no
delete or destructive move path.

## Review cadence and limitations

Review this model when an action type, provider, OAuth scope, MCP tool, feedback
field, policy section, or persistence boundary changes. The model does not claim
protection against an administrator-level local compromise, a malicious browser
extension, a compromised Google account, an unknown dependency attack, or
deliberate misuse by the trusted operator. Real-drive validation remains gated
on explicit OAuth consent and one selected folder after all synthetic release
evidence is green.
