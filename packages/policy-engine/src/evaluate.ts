import type { PolicyPack } from "@dvw/core";
import type {
  ArchivePolicyInput,
  ArchivePolicyResult,
  EntityAliasResult,
  MatchedPolicyRule,
  MaterialPolicyQuestion,
  ProtectedFlag,
  ProtectedItemInput,
  ProtectedItemResult,
  ShortcutPolicyInput,
  ShortcutPolicyResult,
} from "./types.js";

const COMMUNICATIONS_DIRECT_REASON = "PAISANO.COMMUNICATIONS.DIRECT_OPTION";
const COMMUNICATIONS_LOGGED_REASON = "PAISANO.COMMUNICATIONS.LOGGED_OPTION";

function policyLocator(
  version: string,
  filename: string,
  fragment: string,
): string {
  return `paisano:${version}/${filename}#${encodeURIComponent(fragment)}`;
}

function normalized(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}

function destinationFromTemplate(template: string): string {
  return template.replace(/\{name\}$/u, "");
}

function validIsoDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function protectedSelectorMatches(
  selector: string,
  flags: ReadonlySet<ProtectedFlag>,
): boolean {
  if (!selector.startsWith("flag:")) return false;
  return flags.has(selector.slice("flag:".length) as ProtectedFlag);
}

export function listMaterialQuestions(
  pack: PolicyPack,
): readonly MaterialPolicyQuestion[] {
  const direct = pack.namingRules.find(
    (rule) => rule.reasonCode === COMMUNICATIONS_DIRECT_REASON,
  );
  const logged = pack.namingRules.find(
    (rule) => rule.reasonCode === COMMUNICATIONS_LOGGED_REASON,
  );

  if (direct === undefined || logged === undefined) return [];

  return [
    {
      choices: [
        destinationFromTemplate(direct.template),
        destinationFromTemplate(logged.template),
      ],
      key: "communications.canonical-destination",
      material: true,
      policyLocators: [
        policyLocator(pack.version, "naming.json", direct.reasonCode),
        policyLocator(pack.version, "naming.json", logged.reasonCode),
      ],
      prompt: "Which folder is the canonical destination for communications?",
      reasonCode: "PAISANO.COMMUNICATIONS.PATH_DECISION_REQUIRED",
      scope: { id: null, type: "global" },
    },
  ];
}

export function evaluateShortcut(
  pack: PolicyPack,
  input: ShortcutPolicyInput,
): ShortcutPolicyResult {
  const defaultRule: MatchedPolicyRule = {
    policyLocator: policyLocator(
      pack.version,
      "shortcut-rules.json",
      "default",
    ),
    reasonCode: "PAISANO.SHORTCUT.DEFAULT_LIMIT",
  };

  if (input.existingDestinationFolderIds.includes(input.destinationFolderId)) {
    return {
      actionType: "KEEP",
      allowed: false,
      matchedRules: [defaultRule],
      reasonCode: "PAISANO.SHORTCUT.ALREADY_EXISTS",
      sourceId: input.sourceId,
    };
  }

  const exception = pack.shortcutRules.exceptions.find((candidate) => {
    const folderName = candidate.selector.startsWith("folder-name:")
      ? candidate.selector.slice("folder-name:".length)
      : null;
    return (
      folderName !== null &&
      normalized(folderName) === normalized(input.destinationFolderName)
    );
  });

  if (exception !== undefined) {
    const matchedRule: MatchedPolicyRule = {
      policyLocator: policyLocator(
        pack.version,
        "shortcut-rules.json",
        `exceptions/${exception.id}`,
      ),
      reasonCode: exception.reasonCode,
    };
    const datedBatch =
      exception.mode === "DATED_BATCH" && validIsoDate(input.batchDate);

    return {
      actionType: datedBatch ? "CREATE_SHORTCUT" : "NEEDS_REVIEW",
      allowed: datedBatch,
      matchedRules: [matchedRule],
      reasonCode: datedBatch
        ? exception.reasonCode
        : "PAISANO.SHORTCUT.DATED_BATCH_REQUIRED",
      sourceId: input.sourceId,
    };
  }

  const belowLimit =
    input.existingDestinationFolderIds.length < pack.shortcutRules.maxPerSource;
  return {
    actionType: belowLimit ? "CREATE_SHORTCUT" : "NEEDS_REVIEW",
    allowed: belowLimit,
    matchedRules: [defaultRule],
    reasonCode: belowLimit
      ? "PAISANO.SHORTCUT.DEFAULT_ALLOWED"
      : "PAISANO.SHORTCUT.DEFAULT_LIMIT_REACHED",
    sourceId: input.sourceId,
  };
}

export function evaluateProtectedItem(
  pack: PolicyPack,
  input: ProtectedItemInput,
): ProtectedItemResult {
  const flags = new Set(input.flags);
  const matchedRules = pack.protectedItems
    .filter((rule) => protectedSelectorMatches(rule.selector, flags))
    .map((rule) => ({
      policyLocator: policyLocator(
        pack.version,
        "protected-items.json",
        rule.selector,
      ),
      reasonCode: rule.reasonCode,
    }));

  return {
    actionType: matchedRules.length === 0 ? "KEEP" : "NEEDS_REVIEW",
    itemId: input.itemId,
    matchedRules,
    reasonCode:
      matchedRules[0]?.reasonCode ?? "PAISANO.PROTECTED.NO_RULE_MATCH",
  };
}

function archiveSelectorMatches(
  selector: string,
  input: ArchivePolicyInput,
): boolean {
  if (selector === "flag:frozen-archive") return input.isFrozen;
  if (selector === "flag:configured-archive") return input.isConfigured;
  if (selector.startsWith("archive-identity:")) {
    const component = selector.slice("archive-identity:".length);
    return input.identityComponents.some(
      (candidate) => candidate === component,
    );
  }
  return false;
}

export function evaluateArchive(
  pack: PolicyPack,
  input: ArchivePolicyInput,
): ArchivePolicyResult {
  const matched = pack.archiveRules.filter((rule) =>
    archiveSelectorMatches(rule.selector, input),
  );
  const matchedRules = matched.map((rule) => ({
    policyLocator: policyLocator(
      pack.version,
      "archive-rules.json",
      rule.selector,
    ),
    reasonCode: rule.reasonCode,
  }));
  const preserveHierarchy = matched.some((rule) => rule.preserveHierarchy);

  if (!input.isArchive) {
    return {
      actionType: "KEEP",
      itemId: input.itemId,
      matchedRules,
      preserveHierarchy: false,
      reasonCode: "PAISANO.ARCHIVE.NOT_AN_ARCHIVE",
    };
  }

  return {
    actionType: preserveHierarchy ? "PRESERVE_ARCHIVE" : "NEEDS_REVIEW",
    itemId: input.itemId,
    matchedRules,
    preserveHierarchy,
    reasonCode:
      matchedRules[0]?.reasonCode ?? "PAISANO.ARCHIVE.UNCLASSIFIED_REVIEW",
  };
}

export function resolveEntityAlias(
  pack: PolicyPack,
  candidateAlias: string,
): EntityAliasResult {
  const alias = pack.entityAliases.find(
    (configured) => normalized(configured.alias) === normalized(candidateAlias),
  );

  if (alias === undefined) {
    return {
      canonicalEntityId: null,
      matchedRule: null,
      reasonCode: "PAISANO.ENTITY.UNKNOWN_ALIAS",
      status: "NEEDS_REVIEW",
    };
  }

  return {
    canonicalEntityId: alias.entityId,
    matchedRule: {
      policyLocator: policyLocator(pack.version, "entities.json", alias.alias),
      reasonCode: "PAISANO.ENTITY.ALIAS_MATCH",
    },
    reasonCode: "PAISANO.ENTITY.ALIAS_MATCH",
    status: "MATCHED",
  };
}
