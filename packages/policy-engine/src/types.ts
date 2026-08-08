import type { ActionType, PolicyPack } from "@dvw/core";

export interface MatchedPolicyRule {
  policyLocator: string;
  reasonCode: string;
}

export interface MaterialPolicyQuestion {
  choices: readonly string[];
  key: string;
  material: true;
  policyLocators: readonly string[];
  prompt: string;
  reasonCode: string;
  scope: {
    id: null;
    type: "global";
  };
}

export interface ShortcutPolicyInput {
  batchDate: string | null;
  destinationFolderId: string;
  destinationFolderName: string;
  existingDestinationFolderIds: readonly string[];
  sourceId: string;
}

export interface ShortcutPolicyResult {
  actionType: Extract<ActionType, "CREATE_SHORTCUT" | "KEEP" | "NEEDS_REVIEW">;
  allowed: boolean;
  matchedRules: readonly MatchedPolicyRule[];
  reasonCode: string;
  sourceId: string;
}

export type ProtectedFlag =
  "configured-archive" | "data-room" | "legal-original" | "signed-document";

export interface ProtectedItemInput {
  flags: readonly ProtectedFlag[];
  itemId: string;
}

export interface ProtectedItemResult {
  actionType: Extract<ActionType, "KEEP" | "NEEDS_REVIEW">;
  itemId: string;
  matchedRules: readonly MatchedPolicyRule[];
  reasonCode: string;
}

export type ArchiveIdentityComponent = "date" | "deal" | "sender" | "source";

export interface ArchivePolicyInput {
  identityComponents: readonly ArchiveIdentityComponent[];
  isArchive: boolean;
  isConfigured: boolean;
  isFrozen: boolean;
  itemId: string;
}

export interface ArchivePolicyResult {
  actionType: Extract<ActionType, "KEEP" | "NEEDS_REVIEW" | "PRESERVE_ARCHIVE">;
  itemId: string;
  matchedRules: readonly MatchedPolicyRule[];
  preserveHierarchy: boolean;
  reasonCode: string;
}

export type EntityAliasResult =
  | {
      canonicalEntityId: string;
      matchedRule: MatchedPolicyRule;
      reasonCode: "PAISANO.ENTITY.ALIAS_MATCH";
      status: "MATCHED";
    }
  | {
      canonicalEntityId: null;
      matchedRule: null;
      reasonCode: "PAISANO.ENTITY.UNKNOWN_ALIAS";
      status: "NEEDS_REVIEW";
    };

export type ValidatedPolicyPack = PolicyPack;
