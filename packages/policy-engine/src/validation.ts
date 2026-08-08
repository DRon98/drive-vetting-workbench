import { PolicyPackSchema, type PolicyPack } from "@dvw/core";

const SEMANTIC_VERSION = /^\d+\.\d+\.\d+$/u;

export class PolicyPackValidationError extends Error {
  readonly code = "POLICY_PACK_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PolicyPackValidationError";
  }
}

function normalizeKey(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}

function assertNoContradiction<T>(
  items: readonly T[],
  keyFor: (item: T) => string,
  valueFor: (item: T) => string,
  label: string,
): void {
  const activeValues = new Map<string, string>();

  for (const item of items) {
    const key = keyFor(item);
    const value = valueFor(item);
    const prior = activeValues.get(key);
    if (prior !== undefined && prior !== value) {
      throw new PolicyPackValidationError(`contradictory ${label}: ${key}`);
    }
    activeValues.set(key, value);
  }
}

function validateTaxonomy(pack: PolicyPack): void {
  const ids = new Set(pack.taxonomy.map((node) => node.id));
  for (const node of pack.taxonomy) {
    if (node.parentId !== null && !ids.has(node.parentId)) {
      throw new PolicyPackValidationError(
        `taxonomy parent does not exist: ${node.parentId}`,
      );
    }

    const visited = new Set<string>([node.id]);
    let current = node;
    while (current.parentId !== null) {
      if (visited.has(current.parentId)) {
        throw new PolicyPackValidationError(`taxonomy cycle at: ${node.id}`);
      }
      visited.add(current.parentId);
      const parent = pack.taxonomy.find(
        (candidate) => candidate.id === current.parentId,
      );
      if (parent === undefined) break;
      current = parent;
    }
  }
}

export function validatePolicyPack(input: unknown): PolicyPack {
  const pack = PolicyPackSchema.parse(input);

  if (!SEMANTIC_VERSION.test(pack.version)) {
    throw new PolicyPackValidationError(
      `policy version must be a semantic version: ${pack.version}`,
    );
  }

  assertNoContradiction(
    pack.taxonomy,
    (node) => node.id,
    (node) => JSON.stringify([node.label, node.parentId]),
    "taxonomy node",
  );
  assertNoContradiction(
    pack.namingRules,
    (rule) => rule.reasonCode,
    (rule) => rule.template,
    "naming rule",
  );
  assertNoContradiction(
    pack.documentTypes,
    (documentType) => documentType.id,
    (documentType) => documentType.label,
    "document type",
  );
  assertNoContradiction(
    pack.entityAliases,
    (entityAlias) => normalizeKey(entityAlias.alias),
    (entityAlias) => entityAlias.entityId,
    "entity alias",
  );
  assertNoContradiction(
    pack.archiveRules,
    (rule) => rule.selector,
    (rule) => JSON.stringify([rule.preserveHierarchy, rule.reasonCode]),
    "archive rule",
  );
  assertNoContradiction(
    pack.protectedItems,
    (rule) => rule.selector,
    (rule) => rule.reasonCode,
    "protected item rule",
  );
  assertNoContradiction(
    pack.shortcutRules.exceptions,
    (exception) => exception.selector,
    (exception) =>
      JSON.stringify([
        exception.id,
        exception.maxPerSource,
        exception.mode,
        exception.reasonCode,
      ]),
    "shortcut exception",
  );
  assertNoContradiction(
    pack.shortcutRules.exceptions,
    (exception) => exception.id,
    (exception) =>
      JSON.stringify([
        exception.maxPerSource,
        exception.mode,
        exception.reasonCode,
        exception.selector,
      ]),
    "shortcut exception id",
  );
  assertNoContradiction(
    pack.precedents,
    (precedent) => `${precedent.scope}\u0000${precedent.key}`,
    (precedent) => precedent.decision,
    "precedent",
  );
  validateTaxonomy(pack);

  return pack;
}
