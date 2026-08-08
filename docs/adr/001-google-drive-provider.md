# ADR 001: Google Drive v3 Provider and Staged OAuth Profiles

- Status: Accepted
- Date: 2026-08-08
- Task: T19

## Context

The workbench must scan one operator-selected Google Drive folder and apply only
approved renames and shortcuts. It must support My Drive and Shared Drives. It
must keep credentials local, expose no broad agent mutation tool, and run all
required tests without credentials or live Drive data.

The core provider contract already limits reads to list, get, and export. It
limits mutations to rename and create shortcut. Google-specific clients must
stay behind that boundary.

Current Google guidance affects the authorization design:

- [OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
  recommends a loopback callback and PKCE. Manual copy and paste is not
  supported. Installed apps do not support incremental authorization.
- [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
  define `drive.metadata.readonly`, `drive.readonly`, `drive.file`, and `drive`.
  The `drive.file` scope can change files created by or explicitly shared with
  the app through a picker. The current CLI accepts a folder ID and does not use
  Google Picker, so it cannot rely on `drive.file` to rename arbitrary existing
  items in that folder.
- [Shared Drive support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)
  requires `supportsAllDrives` and `includeItemsFromAllDrives`. A known Shared
  Drive uses `corpora=drive` with `driveId`.
- [`files.list`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
  can return `incompleteSearch`. A non-empty next page token means the scan is
  incomplete until another page is fetched.
- [Drive error guidance](https://developers.google.com/workspace/drive/api/guides/handle-errors)
  recommends bounded exponential backoff for quota and transient failures.
- [`files.export`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)
  returns bytes and limits an export to 10 MB.

## Decision

### Authorization profiles

Use three separate installed-app consent and token profiles:

| Profile    | Scope                                                     | Provider surface       |
| ---------- | --------------------------------------------------------- | ---------------------- |
| `metadata` | `https://www.googleapis.com/auth/drive.metadata.readonly` | Read metadata only     |
| `content`  | `https://www.googleapis.com/auth/drive.readonly`          | Read metadata + export |
| `apply`    | `https://www.googleapis.com/auth/drive`                   | Read + two mutations   |

Do not escalate one token. Installed apps do not support incremental
authorization. Each mode has a separate token file and a separate consent event.
A metadata or content configuration cannot construct a mutation provider.

The apply scope is restricted. It is necessary for the current folder-ID
workflow. Reconsider `drive.file` only after an explicit Google Picker selection
flow exists and contract tests prove that every approved existing target is
shared with the app.

### Installed-app flow and storage

Use `google-auth-library` for OAuth2 and Google's modular `@googleapis/drive`
client for Drive v3. Do not load the umbrella client and its unrelated API
surface. Start an HTTP listener on `127.0.0.1` with a random port. Generate a
per-request PKCE verifier and `S256` challenge. Generate a random CSRF state and
require the callback to match it. Open the consent URL in the local browser. Do
not support an out-of-band copy and paste flow.

Store only authorized-user refresh credentials. Default to the user's local
configuration directory. Resolve symlinks and reject token and client-credential
paths inside the workspace. Use mode `0700` for the token directory and `0600`
for each token file. Create token files exclusively. Do not overwrite or remove
an existing token through the runtime.

### Drive request mapping

- List direct children with a parent query, complete fields, pagination, Drive
  space, `supportsAllDrives=true`, and `includeItemsFromAllDrives=true`.
- Use `corpora=drive` and `driveId` when the operator configures a Shared Drive.
  Otherwise use `corpora=user`.
- Treat `incompleteSearch=true`, malformed file metadata, or invalid paging as
  provider failure. Do not publish partial coverage as complete.
- Request IDs, names, MIME types, parents, timestamps, trash state, checksums,
  shortcut target IDs, and current-user capabilities. Convert checksums to a
  typed fingerprint prefix.
- Use capability fields for the compact permission summary. Keep raw permission
  lists out of the provider contract.
- Before rename, fetch the target and compare its live `modifiedTime` with the
  approved precondition. Send only the `name` field in `files.update` with
  `supportsAllDrives=true`.
- Create only `application/vnd.google-apps.shortcut` resources. Send exactly one
  parent and one shortcut target. Do not add parent-removal, trash, body update,
  copy, or other mutation operations.
- Re-fetch and receipt verification remain in the T18 executor. A provider
  response alone is not success evidence.

### Errors and retries

Map Google errors to the core typed errors. Do not expose raw provider messages,
response bodies, tokens, or request data.

- Map 403/429 quota reasons to `RATE_LIMITED`.
- Map permission and authorization failures to `DENIED`.
- Map 404 to a missing item for `getItem`, and to `NOT_FOUND` elsewhere.
- Map export limitations to `UNSUPPORTED_EXPORT`.
- Map conflict or precondition failures to `STALE_STATE`.
- Map 5xx and selected network failures to retryable `PROVIDER_FAILURE`.

Retry only list, get, and export. Use bounded exponential backoff with jitter.
Do not automatically retry rename or create shortcut. A lost mutation response
is ambiguous; the executor must re-fetch and resume safely.

### Tests and optional sandbox

The required contract suite injects a scripted Google API client. It does not
load credentials and cannot contact Google. It verifies request parameters,
response mapping, scope isolation, PKCE callback behavior, typed errors, retry
limits, token permissions, and redacted request snapshots.

`pnpm test:google-sandbox` is optional. It stays skipped unless
`DVW_GOOGLE_SANDBOX=1`. It requires an explicit client path and root ID, checks
that the root name starts with `DVW Sandbox`, uses the content-read profile, and
performs no mutation. The sandbox is unrun until an operator supplies a
disposable synthetic account and folder.

## googleworkspace/cli reference

The [Google Workspace CLI](https://github.com/googleworkspace/cli) is useful as
a research reference for Discovery-based schemas, structured output, pagination,
scope selection, and local credential handling. It is pre-1.0, dynamically
builds its command surface, and states that it is not an officially supported
Google product. It is not a runtime dependency. A future adapter can be proposed
only if it preserves the provider contract and approval boundary.

## Consequences

- Read-only operation cannot silently gain write capability.
- Apply requires a separate, explicit restricted-scope consent.
- Credentials remain local and outside the repository.
- Shared Drive behavior is deterministic when the drive ID is configured.
- Transient reads can recover, while ambiguous writes fail closed for live
  verification and resume.
- A future Picker-based design can reduce the apply scope, but that is a new
  contract decision and not part of version 1.
