import { createHash } from "node:crypto";
import {
  EvidenceBundleSchema,
  type EvidenceBundle,
  type EvidenceSource,
  type PolicyPack,
} from "@dvw/core";
import type { IndexedItem } from "@dvw/evidence-store-sqlite";
import {
  evaluateArchive,
  evaluateProtectedItem,
  resolveEntityAlias,
  type ArchiveIdentityComponent,
  type ArchivePolicyResult,
  type ProtectedFlag,
  type ProtectedItemResult,
} from "@dvw/policy-engine";

type EvidenceFact = EvidenceBundle["observedFacts"][number];
type EvidenceFactValue = EvidenceFact["value"];
type EvidenceConflict = EvidenceBundle["conflicts"][number];
type MatchedRule = EvidenceBundle["matchedRules"][number];

export type NamingPartKind =
  "date" | "document-type" | "entity" | "sender" | "title";

export interface NamingPartCandidate {
  readonly confidence: number;
  readonly kind: NamingPartKind;
  readonly sourceLocators: readonly string[];
  readonly value: string;
}

export interface DuplicateCandidate {
  readonly fingerprint: string;
  readonly itemId: string;
  readonly matchedFields: readonly (
    "contentFingerprint" | "mimeType" | "sizeBytes"
  )[];
  readonly sourceLocators: readonly string[];
}

export interface EvidenceAncestor {
  readonly id: string;
  readonly name: string;
  readonly sourceLocator: string;
}

export interface ObservedDealContext {
  readonly dealId: string;
  readonly sourceLocator: string;
}

export interface EvidenceBuildContext {
  readonly ancestors: readonly EvidenceAncestor[];
  readonly archive: {
    readonly identityComponents: readonly ArchiveIdentityComponent[];
    readonly isArchive: boolean;
    readonly isConfigured: boolean;
    readonly isFrozen: boolean;
  };
  readonly declaredActiveDealId: string | null;
  readonly declaredContextLocator: string;
  readonly observedDeals: readonly ObservedDealContext[];
  readonly protectedFlags: readonly ProtectedFlag[];
}

export interface EvidenceBuildOptions {
  readonly maxCandidates?: number;
  readonly maxConflicts?: number;
  readonly maxDuplicates?: number;
  readonly maxFacts?: number;
  readonly maxLocatorsPerCandidate?: number;
  readonly maxMatchedRules?: number;
  readonly maxNamingParts?: number;
  readonly maxPacketBytes?: number;
  readonly maxSnippetBytes?: number;
}

export interface EvidenceBuildInput {
  readonly context: EvidenceBuildContext;
  readonly items: readonly IndexedItem[];
  readonly options?: EvidenceBuildOptions;
  readonly pack: PolicyPack;
  readonly targetId: string;
}

export interface EvidenceBuildResult {
  readonly bundle: EvidenceBundle;
  readonly context: {
    readonly archive: ArchivePolicyResult & {
      readonly identityComponents: readonly ArchiveIdentityComponent[];
      readonly isArchive: boolean;
      readonly isConfigured: boolean;
      readonly isFrozen: boolean;
    };
    readonly protected: ProtectedItemResult & {
      readonly flags: readonly ProtectedFlag[];
    };
  };
  readonly duplicateCandidates: readonly DuplicateCandidate[];
  readonly namingParts: readonly NamingPartCandidate[];
  readonly policyVersion: string;
  readonly reviewState: "DETERMINISTIC" | "NEEDS_REVIEW";
  readonly scanGeneration: string;
}

interface RequiredBuildOptions {
  readonly maxCandidates: number;
  readonly maxConflicts: number;
  readonly maxDuplicates: number;
  readonly maxFacts: number;
  readonly maxLocatorsPerCandidate: number;
  readonly maxMatchedRules: number;
  readonly maxNamingParts: number;
  readonly maxPacketBytes: number;
  readonly maxSnippetBytes: number;
}

interface CandidateEvidence {
  confidence: number;
  locators: Set<string>;
}

const DEFAULT_OPTIONS: RequiredBuildOptions = {
  maxCandidates: 8,
  maxConflicts: 16,
  maxDuplicates: 16,
  maxFacts: 32,
  maxLocatorsPerCandidate: 8,
  maxMatchedRules: 32,
  maxNamingParts: 16,
  maxPacketBytes: 256 * 1024,
  maxSnippetBytes: 2048,
};

const NAMING_PART_ORDER: Readonly<Record<NamingPartKind, number>> = {
  date: 0,
  entity: 1,
  "document-type": 2,
  sender: 3,
  title: 4,
};

const MIME_DOCUMENT_TYPE_CUES: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.email": "correspondence",
  "message/rfc822": "correspondence",
};

export class EvidenceBuilderError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceBuilderError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new EvidenceBuilderError(
      "INVALID_INPUT",
      `${field} must not be empty.`,
    );
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EvidenceBuilderError(
      "INVALID_INPUT",
      `${field} must be a positive safe integer.`,
    );
  }
  return value;
}

function buildOptions(
  input: EvidenceBuildOptions | undefined,
): RequiredBuildOptions {
  return {
    maxCandidates: positiveInteger(
      input?.maxCandidates ?? DEFAULT_OPTIONS.maxCandidates,
      "maxCandidates",
    ),
    maxConflicts: positiveInteger(
      input?.maxConflicts ?? DEFAULT_OPTIONS.maxConflicts,
      "maxConflicts",
    ),
    maxDuplicates: positiveInteger(
      input?.maxDuplicates ?? DEFAULT_OPTIONS.maxDuplicates,
      "maxDuplicates",
    ),
    maxFacts: positiveInteger(
      input?.maxFacts ?? DEFAULT_OPTIONS.maxFacts,
      "maxFacts",
    ),
    maxLocatorsPerCandidate: positiveInteger(
      input?.maxLocatorsPerCandidate ?? DEFAULT_OPTIONS.maxLocatorsPerCandidate,
      "maxLocatorsPerCandidate",
    ),
    maxMatchedRules: positiveInteger(
      input?.maxMatchedRules ?? DEFAULT_OPTIONS.maxMatchedRules,
      "maxMatchedRules",
    ),
    maxNamingParts: positiveInteger(
      input?.maxNamingParts ?? DEFAULT_OPTIONS.maxNamingParts,
      "maxNamingParts",
    ),
    maxPacketBytes: positiveInteger(
      input?.maxPacketBytes ?? DEFAULT_OPTIONS.maxPacketBytes,
      "maxPacketBytes",
    ),
    maxSnippetBytes: positiveInteger(
      input?.maxSnippetBytes ?? DEFAULT_OPTIONS.maxSnippetBytes,
      "maxSnippetBytes",
    ),
  };
}

function normalize(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

function canonicalJson(value: EvidenceFactValue): string {
  const normalizeJson = (candidate: EvidenceFactValue): EvidenceFactValue => {
    if (Array.isArray(candidate)) {
      return candidate.map((entry) => normalizeJson(entry));
    }
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .sort(([left], [right]) => compareText(left, right))
          .map(([key, entry]) => [key, normalizeJson(entry)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalizeJson(value));
}

function factId(
  targetId: string,
  field: string,
  sourceLocator: string,
  value: EvidenceFactValue,
): string {
  const digest = createHash("sha256")
    .update(`${targetId}\u0000${field}\u0000${sourceLocator}\u0000`)
    .update(canonicalJson(value))
    .digest("hex");
  return `fact_${digest}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function policyLocator(
  version: string,
  filename: string,
  fragment: string,
): string {
  return `paisano:${version}/${filename}#${encodeURIComponent(fragment)}`;
}

function validDates(value: string): string[] {
  const dates = new Set<string>();
  for (const match of value.matchAll(
    /(?<!\d)(20\d{2})[-_](0[1-9]|1[0-2])[-_](0[1-9]|[12]\d|3[01])(?!\d)/gu,
  )) {
    const candidate = `${match[1]}-${match[2]}-${match[3]}`;
    const parsed = new Date(`${candidate}T00:00:00.000Z`);
    if (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === candidate
    ) {
      dates.add(candidate);
    }
  }
  return [...dates].sort(compareText);
}

function senderCues(value: string): string[] {
  const senders = new Set<string>();
  for (const match of value.matchAll(
    /(?:^|\n)\s*From:\s*([^\r\n]{1,200})/giu,
  )) {
    const sender = match[1]?.normalize("NFC").trim();
    if (sender !== undefined && sender.length > 0) senders.add(sender);
  }
  return [...senders].sort(compareText);
}

function strongFingerprint(value: string | null): value is string {
  return value !== null && /^sha256:[a-f0-9]{64}$/iu.test(value);
}

function addCandidateEvidence(
  candidates: Map<string, CandidateEvidence>,
  key: string,
  confidence: number,
  sourceLocator: string,
): void {
  const existing = candidates.get(key);
  if (existing === undefined) {
    candidates.set(key, {
      confidence,
      locators: new Set([sourceLocator]),
    });
    return;
  }
  existing.confidence = Math.max(existing.confidence, confidence);
  existing.locators.add(sourceLocator);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function inferredTitle(
  name: string,
  aliases: readonly string[],
  documentTypeLabels: readonly string[],
): string | null {
  let title = name.replace(/\.[a-z0-9]{1,12}$/iu, " ");
  title = title.replace(
    /(?<!\d)20\d{2}[-_](?:0[1-9]|1[0-2])[-_](?:0[1-9]|[12]\d|3[01])(?!\d)/gu,
    " ",
  );
  const removable = [...aliases, ...documentTypeLabels].sort(
    (left, right) => right.length - left.length || compareText(left, right),
  );
  for (const phrase of removable) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    title = title.replace(new RegExp(escaped, "giu"), " ");
  }
  title = title
    .replace(/[_\-–—]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return title.length === 0 ? null : title;
}

export function buildEvidenceBundle(
  input: EvidenceBuildInput,
): EvidenceBuildResult {
  assertNonEmpty(input.targetId, "targetId");
  assertNonEmpty(
    input.context.declaredContextLocator,
    "declaredContextLocator",
  );
  const options = buildOptions(input.options);
  const itemIds = new Set<string>();
  for (const item of input.items) {
    if (itemIds.has(item.id)) {
      throw new EvidenceBuilderError(
        "DUPLICATE_ITEM_ID",
        `Item ${item.id} occurs more than once.`,
      );
    }
    itemIds.add(item.id);
  }
  const target = input.items.find((item) => item.id === input.targetId);
  if (target === undefined) {
    throw new EvidenceBuilderError(
      "TARGET_NOT_FOUND",
      `Target ${input.targetId} is not present in the evidence items.`,
    );
  }
  if (
    input.items.some((item) => item.scanGeneration !== target.scanGeneration)
  ) {
    throw new EvidenceBuilderError(
      "MIXED_GENERATIONS",
      "All evidence items must come from the target scan generation.",
    );
  }

  const rawFacts: EvidenceFact[] = [];
  const rawConflicts: EvidenceConflict[] = [];
  const matchedRules = new Map<string, MatchedRule>();
  const documentTypes = new Map<string, CandidateEvidence>();
  const entities = new Map<string, CandidateEvidence>();
  const namingParts = new Map<string, NamingPartCandidate>();
  const duplicateCandidates: DuplicateCandidate[] = [];
  let locatorBudgetExceeded = false;
  const itemNameLocator = `drive:item:${target.id}#name`;
  const itemMimeLocator = `drive:item:${target.id}#mimeType`;
  const itemParentLocator = `drive:item:${target.id}#parentIds`;
  const itemFingerprintLocator = `drive:item:${target.id}#contentFingerprint`;
  const itemSizeLocator = `drive:item:${target.id}#sizeBytes`;
  const itemPermissionsLocator = `drive:item:${target.id}#permissions`;
  const snippetLocator =
    target.contentLocator ?? `drive:item:${target.id}#content-unavailable`;
  const boundedSnippet =
    target.extractedSnippet === null
      ? null
      : utf8Prefix(target.extractedSnippet, options.maxSnippetBytes);

  const addFact = (
    field: string,
    source: EvidenceSource,
    sourceLocator: string,
    value: EvidenceFactValue,
  ): void => {
    rawFacts.push({
      field,
      id: factId(target.id, field, sourceLocator, value),
      source,
      sourceLocator,
      value,
    });
  };
  const addRule = (rule: MatchedRule): void => {
    matchedRules.set(`${rule.policyLocator}\u0000${rule.reasonCode}`, rule);
  };
  const addNamingPart = (
    kind: NamingPartKind,
    value: string,
    confidence: number,
    locators: readonly string[],
  ): void => {
    const key = `${kind}\u0000${value}`;
    const existing = namingParts.get(key);
    if (existing === undefined) {
      const sourceLocators = uniqueSorted(locators);
      if (sourceLocators.length > options.maxLocatorsPerCandidate) {
        locatorBudgetExceeded = true;
      }
      namingParts.set(key, {
        confidence,
        kind,
        sourceLocators: sourceLocators.slice(
          0,
          options.maxLocatorsPerCandidate,
        ),
        value,
      });
      return;
    }
    const sourceLocators = uniqueSorted([
      ...existing.sourceLocators,
      ...locators,
    ]);
    if (sourceLocators.length > options.maxLocatorsPerCandidate) {
      locatorBudgetExceeded = true;
    }
    namingParts.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, confidence),
      sourceLocators: sourceLocators.slice(0, options.maxLocatorsPerCandidate),
    });
  };

  addFact("item.name", "Observed", itemNameLocator, target.name);
  addFact("item.mimeType", "Observed", itemMimeLocator, target.mimeType);
  const parentIds = uniqueSorted(target.parentIds);
  if (parentIds.length > options.maxLocatorsPerCandidate) {
    locatorBudgetExceeded = true;
  }
  addFact(
    "item.parentIds",
    "Observed",
    itemParentLocator,
    parentIds.slice(0, options.maxLocatorsPerCandidate),
  );
  addFact(
    "item.createdTime",
    "Observed",
    `drive:item:${target.id}#createdTime`,
    target.createdTime,
  );
  addFact(
    "item.modifiedTime",
    "Observed",
    `drive:item:${target.id}#modifiedTime`,
    target.modifiedTime,
  );
  addFact("item.permissions", "Observed", itemPermissionsLocator, {
    canRead: target.permissions.canRead,
    canWrite: target.permissions.canWrite,
    ...(target.permissions.deniedReason === undefined
      ? {}
      : { deniedReason: target.permissions.deniedReason }),
  });
  addFact(
    "item.trashed",
    "Observed",
    `drive:item:${target.id}#trashed`,
    target.trashed,
  );
  if (target.contentFingerprint !== null) {
    addFact(
      "item.contentFingerprint",
      "Observed",
      itemFingerprintLocator,
      target.contentFingerprint,
    );
  }
  if (target.sizeBytes !== null) {
    addFact("item.sizeBytes", "Observed", itemSizeLocator, target.sizeBytes);
  }
  if (target.shortcutTargetId !== null) {
    addFact(
      "item.shortcutTargetId",
      "Observed",
      `drive:item:${target.id}#shortcutTargetId`,
      target.shortcutTargetId,
    );
  }
  if (boundedSnippet !== null) {
    addFact("item.contentSnippet", "Observed", snippetLocator, boundedSnippet);
  }
  for (const ancestor of [...input.context.ancestors].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    assertNonEmpty(ancestor.id, "ancestor.id");
    assertNonEmpty(ancestor.sourceLocator, "ancestor.sourceLocator");
    addFact("path.ancestor", "Observed", ancestor.sourceLocator, {
      id: ancestor.id,
      name: ancestor.name,
    });
  }
  for (const observedDeal of [...input.context.observedDeals].sort(
    (left, right) =>
      compareText(left.dealId, right.dealId) ||
      compareText(left.sourceLocator, right.sourceLocator),
  )) {
    assertNonEmpty(observedDeal.dealId, "observedDeal.dealId");
    assertNonEmpty(observedDeal.sourceLocator, "observedDeal.sourceLocator");
    addFact(
      "path.dealId",
      "Observed",
      observedDeal.sourceLocator,
      observedDeal.dealId,
    );
  }
  if (input.context.declaredActiveDealId !== null) {
    assertNonEmpty(input.context.declaredActiveDealId, "declaredActiveDealId");
    addFact(
      "context.activeDealId",
      "DeclaredContext",
      input.context.declaredContextLocator,
      input.context.declaredActiveDealId,
    );
  }
  if (input.context.protectedFlags.length > 0) {
    addFact(
      "protected.flags",
      "DeclaredContext",
      `context:protected:${target.id}`,
      [...input.context.protectedFlags].sort(compareText),
    );
  }
  if (
    input.context.archive.isArchive ||
    input.context.archive.isConfigured ||
    input.context.archive.isFrozen ||
    input.context.archive.identityComponents.length > 0
  ) {
    addFact(
      "archive.identityComponents",
      "DeclaredContext",
      `context:archive:${target.id}`,
      [...input.context.archive.identityComponents].sort(compareText),
    );
    addFact(
      "archive.state",
      "DeclaredContext",
      `context:archive:${target.id}`,
      {
        isArchive: input.context.archive.isArchive,
        isConfigured: input.context.archive.isConfigured,
        isFrozen: input.context.archive.isFrozen,
      },
    );
  }

  const contentSources = [
    { confidence: 0.98, locator: itemNameLocator, value: target.name },
    ...(boundedSnippet === null
      ? []
      : [
          {
            confidence: 0.78,
            locator: snippetLocator,
            value: boundedSnippet,
          },
        ]),
    ...input.context.ancestors.map((ancestor) => ({
      confidence: 0.7,
      locator: ancestor.sourceLocator,
      value: ancestor.name,
    })),
  ];

  const mimeDocumentType =
    MIME_DOCUMENT_TYPE_CUES[
      target.mimeType.normalize("NFC").trim().toLocaleLowerCase("en-US")
    ];
  if (
    mimeDocumentType !== undefined &&
    input.pack.documentTypes.some((entry) => entry.id === mimeDocumentType)
  ) {
    addCandidateEvidence(
      documentTypes,
      mimeDocumentType,
      0.92,
      itemMimeLocator,
    );
  }

  for (const documentType of input.pack.documentTypes) {
    const phrases = [documentType.id.replaceAll("-", " "), documentType.label];
    for (const source of contentSources) {
      if (
        phrases.some((phrase) =>
          normalize(source.value).includes(normalize(phrase)),
        )
      ) {
        addCandidateEvidence(
          documentTypes,
          documentType.id,
          source.confidence,
          source.locator,
        );
      }
    }
    if (documentTypes.has(documentType.id)) {
      addRule({
        policyLocator: policyLocator(
          input.pack.version,
          "document-types.json",
          documentType.id,
        ),
        reasonCode: "PAISANO.DOCUMENT_TYPE.CUE_MATCH",
      });
    }
  }

  for (const source of contentSources) {
    const bestAliasByEntity = new Map<
      string,
      (typeof input.pack.entityAliases)[number]
    >();
    for (const alias of [...input.pack.entityAliases].sort(
      (left, right) =>
        right.alias.length - left.alias.length ||
        compareText(left.alias, right.alias),
    )) {
      if (
        normalize(source.value).includes(normalize(alias.alias)) &&
        !bestAliasByEntity.has(alias.entityId)
      ) {
        bestAliasByEntity.set(alias.entityId, alias);
      }
    }
    for (const alias of bestAliasByEntity.values()) {
      addCandidateEvidence(
        entities,
        alias.entityId,
        source.confidence,
        source.locator,
      );
      const resolved = resolveEntityAlias(input.pack, alias.alias);
      if (resolved.matchedRule !== null) addRule(resolved.matchedRule);
    }
  }

  for (const [documentTypeId, evidence] of documentTypes) {
    addNamingPart("document-type", documentTypeId, evidence.confidence, [
      ...evidence.locators,
    ]);
  }
  for (const [entityId, evidence] of entities) {
    addNamingPart("entity", entityId, evidence.confidence, [
      ...evidence.locators,
    ]);
  }

  const dateSources = contentSources.flatMap((source) =>
    validDates(source.value).map((date) => ({ ...source, date })),
  );
  for (const date of dateSources) {
    addNamingPart("date", date.date, date.confidence, [date.locator]);
  }
  const distinctDates = uniqueSorted(dateSources.map((entry) => entry.date));
  if (distinctDates.length > 1) {
    rawConflicts.push({
      code: "UNCERTAIN_DATE",
      material: true,
      message: `Multiple date cues apply to ${target.id}: ${distinctDates.join(", ")}.`,
    });
  }

  if (boundedSnippet !== null) {
    for (const sender of senderCues(boundedSnippet)) {
      addNamingPart("sender", sender, 0.9, [snippetLocator]);
    }
  }
  const title = inferredTitle(
    target.name,
    input.pack.entityAliases.map((entry) => entry.alias),
    input.pack.documentTypes.flatMap((entry) => [entry.id, entry.label]),
  );
  if (title !== null) addNamingPart("title", title, 0.85, [itemNameLocator]);

  if (documentTypes.size > 0 || entities.size > 0 || distinctDates.length > 0) {
    const namingRule = input.pack.namingRules.find(
      (rule) => rule.reasonCode === "PAISANO.NAME.DEAL_DOCUMENT",
    );
    if (namingRule !== undefined) {
      addRule({
        policyLocator: policyLocator(
          input.pack.version,
          "naming.json",
          namingRule.reasonCode,
        ),
        reasonCode: namingRule.reasonCode,
      });
    }
  }

  if (entities.size > 1) {
    rawConflicts.push({
      code: "MULTIPLE_ENTITIES",
      material: true,
      message: `Multiple entity candidates apply to ${target.id}: ${uniqueSorted(entities.keys()).join(", ")}.`,
    });
  }

  const observedDealIds = uniqueSorted(
    input.context.observedDeals.map((entry) => entry.dealId),
  );
  if (observedDealIds.length > 1) {
    rawConflicts.push({
      code: "CONTRADICTORY_PATHS",
      material: true,
      message: `Observed paths for ${target.id} identify multiple deals: ${observedDealIds.join(", ")}.`,
    });
  }
  if (
    input.context.declaredActiveDealId !== null &&
    observedDealIds.some(
      (dealId) => dealId !== input.context.declaredActiveDealId,
    )
  ) {
    rawConflicts.push({
      code: "CROSS_DEAL_REFERENCE",
      material: true,
      message: `Observed deal context for ${target.id} conflicts with declared active deal ${input.context.declaredActiveDealId}.`,
    });
  }

  if (strongFingerprint(target.contentFingerprint)) {
    for (const other of [...input.items].sort((left, right) =>
      compareText(left.id, right.id),
    )) {
      if (
        other.id === target.id ||
        other.contentFingerprint !== target.contentFingerprint
      ) {
        continue;
      }
      const sizeCompatible =
        target.sizeBytes === null ||
        other.sizeBytes === null ||
        target.sizeBytes === other.sizeBytes;
      if (other.mimeType !== target.mimeType || !sizeCompatible) {
        rawConflicts.push({
          code: "FINGERPRINT_METADATA_MISMATCH",
          material: true,
          message: `Item ${other.id} shares a strong fingerprint with ${target.id} but has contradictory stable metadata.`,
        });
        continue;
      }
      const matchedFields: DuplicateCandidate["matchedFields"] = [
        "contentFingerprint",
        "mimeType",
        ...(target.sizeBytes !== null && other.sizeBytes === target.sizeBytes
          ? (["sizeBytes"] as const)
          : []),
      ];
      const duplicateLocators = uniqueSorted([
        itemFingerprintLocator,
        itemMimeLocator,
        ...(matchedFields.includes("sizeBytes") ? [itemSizeLocator] : []),
        `drive:item:${other.id}#contentFingerprint`,
        `drive:item:${other.id}#mimeType`,
        ...(matchedFields.includes("sizeBytes")
          ? [`drive:item:${other.id}#sizeBytes`]
          : []),
      ]);
      if (duplicateLocators.length > options.maxLocatorsPerCandidate) {
        locatorBudgetExceeded = true;
      }
      duplicateCandidates.push({
        fingerprint: target.contentFingerprint,
        itemId: other.id,
        matchedFields,
        sourceLocators: duplicateLocators.slice(
          0,
          options.maxLocatorsPerCandidate,
        ),
      });
      rawConflicts.push({
        code: "EXACT_DUPLICATE",
        material: false,
        message: `Item ${other.id} matches ${target.id} by strong fingerprint and compatible stable metadata.`,
      });
    }
  }

  const protectedResult = evaluateProtectedItem(input.pack, {
    flags: [...input.context.protectedFlags],
    itemId: target.id,
  });
  for (const rule of protectedResult.matchedRules) addRule(rule);
  if (protectedResult.matchedRules.length > 0) {
    rawConflicts.push({
      code: "PROTECTED_TARGET",
      material: true,
      message: `Target ${target.id} matches protected policy context and requires review.`,
    });
  }

  const archiveResult = evaluateArchive(input.pack, {
    identityComponents: [...input.context.archive.identityComponents],
    isArchive: input.context.archive.isArchive,
    isConfigured: input.context.archive.isConfigured,
    isFrozen: input.context.archive.isFrozen,
    itemId: target.id,
  });
  for (const rule of archiveResult.matchedRules) addRule(rule);
  if (
    input.context.archive.isArchive &&
    archiveResult.actionType === "NEEDS_REVIEW"
  ) {
    rawConflicts.push({
      code: "ARCHIVE_REVIEW_REQUIRED",
      material: true,
      message: `Archive target ${target.id} has no hierarchy-preservation rule match.`,
    });
  }

  const sortedFacts = rawFacts.sort(
    (left, right) =>
      compareText(left.field, right.field) ||
      compareText(left.sourceLocator, right.sourceLocator) ||
      compareText(left.id, right.id),
  );
  const sortedDocumentTypes = [...documentTypes.entries()]
    .map(([documentTypeId, evidence]) => ({
      confidence: evidence.confidence,
      documentTypeId,
    }))
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        compareText(left.documentTypeId, right.documentTypeId),
    );
  const sortedEntities = [...entities.entries()]
    .map(([entityId, evidence]) => ({
      confidence: evidence.confidence,
      entityId,
    }))
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        compareText(left.entityId, right.entityId),
    );
  const sortedNamingParts = [...namingParts.values()].sort(
    (left, right) =>
      NAMING_PART_ORDER[left.kind] - NAMING_PART_ORDER[right.kind] ||
      right.confidence - left.confidence ||
      compareText(left.value, right.value),
  );
  const sortedDuplicates = duplicateCandidates.sort((left, right) =>
    compareText(left.itemId, right.itemId),
  );
  const sortedRules = [...matchedRules.values()].sort(
    (left, right) =>
      compareText(left.policyLocator, right.policyLocator) ||
      compareText(left.reasonCode, right.reasonCode),
  );

  let budgetExceeded =
    locatorBudgetExceeded ||
    sortedFacts.length > options.maxFacts ||
    sortedDocumentTypes.length > options.maxCandidates ||
    sortedEntities.length > options.maxCandidates ||
    sortedNamingParts.length > options.maxNamingParts ||
    sortedDuplicates.length > options.maxDuplicates ||
    sortedRules.length > options.maxMatchedRules ||
    rawConflicts.length > options.maxConflicts;
  const facts = sortedFacts.slice(0, options.maxFacts);
  const candidateDocumentTypes = sortedDocumentTypes.slice(
    0,
    options.maxCandidates,
  );
  const candidateEntities = sortedEntities.slice(0, options.maxCandidates);
  const selectedNamingParts = sortedNamingParts.slice(
    0,
    options.maxNamingParts,
  );
  const selectedDuplicates = sortedDuplicates.slice(0, options.maxDuplicates);
  const selectedRules = sortedRules.slice(0, options.maxMatchedRules);
  let conflicts = rawConflicts.sort(
    (left, right) =>
      Number(right.material) - Number(left.material) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
  if (budgetExceeded) {
    conflicts = conflicts.slice(0, Math.max(0, options.maxConflicts - 1));
    conflicts.push({
      code: "EVIDENCE_BUDGET_EXCEEDED",
      material: true,
      message: "Evidence exceeded the configured deterministic bundle budget.",
    });
  } else {
    conflicts = conflicts.slice(0, options.maxConflicts);
  }
  budgetExceeded = conflicts.some(
    (conflict) => conflict.code === "EVIDENCE_BUDGET_EXCEEDED",
  );

  const sourceLocators = uniqueSorted([
    ...facts.map((fact) => fact.sourceLocator),
    ...selectedNamingParts.flatMap((part) => part.sourceLocators),
    ...selectedDuplicates.flatMap((duplicate) => duplicate.sourceLocators),
    ...selectedRules.map((rule) => rule.policyLocator),
  ]);
  const bundle = EvidenceBundleSchema.parse({
    candidateDocumentTypes,
    candidateEntities,
    conflicts,
    matchedRules: selectedRules,
    observedFacts: facts,
    sourceLocators,
    targetId: target.id,
  });

  const result: EvidenceBuildResult = {
    bundle,
    context: {
      archive: {
        ...archiveResult,
        identityComponents: uniqueSorted(
          input.context.archive.identityComponents,
        ) as ArchiveIdentityComponent[],
        isArchive: input.context.archive.isArchive,
        isConfigured: input.context.archive.isConfigured,
        isFrozen: input.context.archive.isFrozen,
      },
      protected: {
        ...protectedResult,
        flags: uniqueSorted(input.context.protectedFlags) as ProtectedFlag[],
      },
    },
    duplicateCandidates: selectedDuplicates,
    namingParts: selectedNamingParts,
    policyVersion: input.pack.version,
    reviewState:
      budgetExceeded || conflicts.some((conflict) => conflict.material)
        ? "NEEDS_REVIEW"
        : "DETERMINISTIC",
    scanGeneration: target.scanGeneration,
  };
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") > options.maxPacketBytes
  ) {
    throw new EvidenceBuilderError(
      "EVIDENCE_PACKET_TOO_LARGE",
      "The evidence packet exceeds the configured byte budget.",
    );
  }
  return result;
}
