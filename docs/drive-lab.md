# Drive Lab

Drive Lab is a deterministic, sandboxed Drive-like filesystem. It implements the
same read and mutation interfaces as the Google provider so scanner, planner,
review, preflight, executor, and verifier code do not branch on a provider name.

## Scenarios

The seven built-in scenarios are:

| Scenario               | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `clean`                | Small writable baseline.                                 |
| `messy-paisano`        | Mixed folders, naming evidence, content, and pagination. |
| `pagination-gap`       | Later-page items and a denied final-page gap.            |
| `protected-archive`    | Data Room and frozen archive rules.                      |
| `shortcut-cycle`       | Bounded traversal and cycle reporting.                   |
| `stale-after-approval` | A live precondition changes before apply.                |
| `partial-failure`      | One accepted write followed by a deterministic failure.  |

Every scenario has stable IDs, timestamps, parent edges, shortcut targets, page
boundaries, permissions, content fingerprints, and fault occurrences.

## Storage contract

Drive Lab accepts one selected sandbox root. It canonicalizes that path and
refuses traversal, absolute escapes, null bytes, or symlinks that leave the
sandbox. Content is addressed by SHA-256. State changes append events and new
manifests inside the sandbox.

Reset is append-only. It writes the immutable scenario baseline as the next
state. It does not remove a file or directory. Snapshot and diff use stable item
IDs, not paths or mutable names.

## Test-only edits

An operator can explicitly create a synthetic item, rename it, change parents,
change permissions, change content, or inject a provider fault. These controls
exist to create stale, denied, partial, and wrong-state test conditions. They
are not provider actions in an approved plan.

The runtime provider surface remains smaller:

- reads: `listItems`, `getItem`, and `exportItem`;
- mutations: `rename` and `createShortcut` only.

There is no delete, trash, content-update, copy, or destructive move provider
method.

## Use it

Run the full review and apply path:

```bash
pnpm quickstart:lab
```

Run the small tree, edit, diff, reset, and snapshot transcript:

```bash
pnpm lab:demo
```

Restore all checked adversarial scenario roots through append-only reset:

```bash
pnpm fixtures:reset
```

See the [quick start](quickstart.md) for artifacts and the
[review workflow](review-workflow.md) for the human loop.
