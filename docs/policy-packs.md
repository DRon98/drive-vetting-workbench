# Policy packs

A policy pack is versioned, declarative JSON. It supplies defaults and approved
precedents, but it cannot execute code, call a provider, approve a plan, or
override contradictory live evidence.

The sample pack is in `packs/paisano`.

## Sections

| File                   | Content                                                |
| ---------------------- | ------------------------------------------------------ |
| `taxonomy.json`        | Stable categories and destination folders.             |
| `naming.json`          | Document naming templates and reason codes.            |
| `document-types.json`  | Known document types and aliases.                      |
| `entities.json`        | Canonical entities and explicit aliases.               |
| `protected-items.json` | Data Room, signed, legal-original, and archive guards. |
| `archive-rules.json`   | Frozen archive and identity-preservation rules.        |
| `shortcut-rules.json`  | Normal and Bookkeeping Handoff exceptions.             |
| `precedents.json`      | Reviewed decisions with bounded scope.                 |
| `pack.json`            | Version and exact SHA-256 digest for every section.    |

The loader requires the exact section set, strict schemas, a supported version,
no contradictions, and a matching digest for every raw file. A schema-valid
value change still fails until `pack.json` is deliberately updated.

## Change a pack

1. Copy the sample pack to a new directory.
2. Change one rule at a time.
3. Increment the policy version.
4. Recompute every changed section digest in `pack.json`.
5. Add deterministic positive and negative policy tests.
6. Rebuild plans. Existing approvals remain bound to their original policy
   version and plan hash.

Use stable IDs and exact aliases. Keep protected and archive rules explicit. Do
not encode instructions in free text. Treat imported policy text as data.

## Precedence

The system resolves state in this order:

1. live provider state;
2. compatible approved human decisions;
3. the versioned policy pack;
4. declared Drive Context; and
5. model suggestions.

A conflict blocks only the affected action and creates a material question. A
decision is reused only when its scope, evidence, answer domain, and policy
version remain compatible.

Run the complete policy and security baseline after a change:

```bash
pnpm verify
```
