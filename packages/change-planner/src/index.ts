import { createHash } from "node:crypto";
import {
  ACTION_TYPES,
  ObservedItemSchema,
  ProposedActionSchema,
  createActionId,
  type ActionType,
  type ObservedItem,
  type ProposedAction,
} from "@dvw/core";
import type { QuestionResolution } from "@dvw/decision-memory";
import type { EvidenceBuildResult } from "@dvw/evidence-builder";
import {
  ReasoningSuggestionSchema,
  type ReasoningOutcome,
  type ReasoningSuggestion,
} from "@dvw/reasoning";
import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);
const FolderMimeType = "application/vnd.google-apps.folder";
const ShortcutMimeType = "application/vnd.google-apps.shortcut";
const WRITE_ACTION_TYPES = ["RENAME", "CREATE_SHORTCUT"] as const;

export const PLAN_HASH_CONTRACT = Object.freeze({
  excludedDisplayFields: Object.freeze([
    "blockers",
    "confidence",
    "explanations",
    "reviewState",
  ]),
  includedActionFields: Object.freeze([
    "actionId",
    "desiredState",
    "evidenceIds",
    "policyVersion",
    "preconditions",
    "reasonCode",
    "scanGeneration",
    "targetId",
    "type",
  ]),
  schemaVersion: "dvw.change-plan.v1",
} as const);

export const PLAN_BLOCKER_CODES = [
  "ARCHIVE_PRESERVATION",
  "CONTRADICTORY_DESIRED_STATE",
  "DUPLICATE_SHORTCUT",
  "INVALID_ACTION",
  "MATERIAL_EVIDENCE_CONFLICT",
  "MATERIAL_EVIDENCE_MISSING",
  "NAME_COLLISION",
  "NEEDS_REVIEW_ACTION",
  "PERMISSION_GAP",
  "PROTECTED_ITEM",
  "SHORTCUT_CYCLE",
  "TARGET_ABSENT",
  "UNRESOLVED_QUESTION",
  "VERSION_MISMATCH",
] as const;

export type PlanBlockerCode = (typeof PLAN_BLOCKER_CODES)[number];

const PlanBlockerSchema = z.strictObject({
  actionIds: z.array(NonEmptyStringSchema),
  blockerId: NonEmptyStringSchema,
  code: z.enum(PLAN_BLOCKER_CODES),
  evidenceIds: z.array(NonEmptyStringSchema),
  message: NonEmptyStringSchema,
  targetIds: z.array(NonEmptyStringSchema),
});

const ActionExplanationSchema = z.strictObject({
  actionId: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  writeRequired: z.boolean(),
});

export const ChangePlanSchema = z.strictObject({
  actions: z.array(ProposedActionSchema),
  approvalEligible: z.boolean(),
  blockers: z.array(PlanBlockerSchema),
  canonicalJson: NonEmptyStringSchema,
  effectiveActions: z.array(ProposedActionSchema),
  explanations: z.array(ActionExplanationSchema),
  hashContract: z.literal("dvw.change-plan.v1"),
  planHash: z.string().regex(/^[a-f0-9]{64}$/u),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
});

export type ChangePlan = Readonly<z.infer<typeof ChangePlanSchema>>;
export type PlanBlocker = Readonly<z.infer<typeof PlanBlockerSchema>>;
export type ActionExplanation = Readonly<
  z.infer<typeof ActionExplanationSchema>
>;

export interface PlanningQuestionResolution {
  readonly questionKey: string;
  readonly resolution: QuestionResolution;
}

export interface PlanningCandidate {
  readonly evidence: EvidenceBuildResult;
  readonly maxShortcutsPerSource?: number | null;
  readonly questions: readonly PlanningQuestionResolution[];
  readonly reasoning: Pick<ReasoningOutcome, "status" | "suggestion">;
}

export interface BuildChangePlanInput {
  readonly candidates: readonly PlanningCandidate[];
  readonly observedItems: readonly ObservedItem[];
  readonly policyVersion: string;
  readonly scanGeneration: string;
}

interface MutableBlocker {
  actionIds: string[];
  blockerId: string;
  code: PlanBlockerCode;
  evidenceIds: string[];
  message: string;
  targetIds: string[];
}

interface CandidateAction {
  action: ProposedAction;
  candidate: PlanningCandidate;
  directBlockers: MutableBlocker[];
  target: ObservedItem | null;
}

interface SuggestedAction {
  confidence: number;
  desiredState: Record<string, unknown>;
  evidenceIds: string[];
  reasonCode: string;
  type: ActionType;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function safeJsonClone(
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return typeof value === "string" ? value.normalize("NFC") : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Unsafe JSON value.");
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("Unsafe JSON array.");
    }
    if (ancestors.has(value)) throw new TypeError("Cyclic JSON value.");
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1) {
      throw new TypeError("Unsafe JSON array.");
    }
    ancestors.add(value);
    try {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new TypeError("Unsafe JSON array.");
        }
        result.push(safeJsonClone(descriptor.value, ancestors));
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Unsafe JSON object.");
    }
    if (ancestors.has(value)) throw new TypeError("Cyclic JSON value.");
    ancestors.add(value);
    try {
      const entries: [string, unknown][] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new TypeError("Unsafe JSON object.");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new TypeError("Unsafe JSON object.");
        }
        entries.push([
          key.normalize("NFC"),
          safeJsonClone(descriptor.value, ancestors),
        ]);
      }
      entries.sort(([left], [right]) => compareText(left, right));
      if (new Set(entries.map(([key]) => key)).size !== entries.length) {
        throw new TypeError("JSON keys collide after normalization.");
      }
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(value);
    }
  }
  throw new TypeError("Unsafe JSON value.");
}

function stableJson(value: unknown): string {
  return JSON.stringify(safeJsonClone(value));
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) {
        deepFreeze(descriptor.value);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function blocker(
  code: PlanBlockerCode,
  message: string,
  input: {
    readonly actionIds?: readonly string[];
    readonly evidenceIds?: readonly string[];
    readonly targetIds?: readonly string[];
  },
): MutableBlocker {
  const core = {
    actionIds: uniqueSorted(input.actionIds ?? []),
    code,
    evidenceIds: uniqueSorted(input.evidenceIds ?? []),
    targetIds: uniqueSorted(input.targetIds ?? []),
  };
  return {
    ...core,
    blockerId: `blk_${createHash("sha256")
      .update(stableJson(core))
      .digest("hex")
      .slice(0, 32)}`,
    message,
  };
}

function itemPreconditions(target: ObservedItem): Record<string, unknown> {
  return {
    modifiedTime: target.modifiedTime,
    name: target.name,
    parentIds: uniqueSorted(target.parentIds),
    permissions: {
      canRead: target.permissions.canRead,
      canWrite: target.permissions.canWrite,
    },
    shortcutTargetId: target.shortcutTargetId,
    trashed: target.trashed,
  };
}

function actionPreconditions(
  type: ActionType,
  target: ObservedItem | null,
  desiredState: Readonly<Record<string, unknown>>,
  observedById: ReadonlyMap<string, ObservedItem>,
): Record<string, unknown> {
  if (target === null) return {};
  if (type !== "CREATE_SHORTCUT") return itemPreconditions(target);
  const parentId = desiredState.parentId;
  const destination =
    typeof parentId === "string" ? observedById.get(parentId) : undefined;
  return {
    destination:
      destination === undefined
        ? { id: typeof parentId === "string" ? parentId : "[invalid]" }
        : { id: destination.id, ...itemPreconditions(destination) },
    existingShortcutIds: [...observedById.values()]
      .filter(
        (item) =>
          item.mimeType === ShortcutMimeType &&
          item.shortcutTargetId === target.id,
      )
      .map((item) => item.id)
      .sort(compareText),
    source: itemPreconditions(target),
  };
}

function currentState(target: ObservedItem): Record<string, unknown> {
  return {
    name: target.name,
    parentIds: uniqueSorted(target.parentIds),
  };
}

function desiredStateFor(
  type: ActionType,
  desiredState: Readonly<Record<string, unknown>>,
  target: ObservedItem | null,
): Record<string, unknown> | null {
  if (type === "NEEDS_REVIEW") return {};
  if (target === null) return null;
  if (type === "KEEP") return currentState(target);
  if (type === "PRESERVE_ARCHIVE") {
    return { parentIds: uniqueSorted(target.parentIds) };
  }
  let safe: unknown;
  try {
    safe = safeJsonClone(desiredState);
  } catch {
    return null;
  }
  if (safe === null || Array.isArray(safe) || typeof safe !== "object") {
    return null;
  }
  const record = safe as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareText);
  if (type === "RENAME") {
    if (
      keys.length !== 1 ||
      keys[0] !== "name" ||
      typeof record.name !== "string" ||
      record.name.length === 0
    ) {
      return null;
    }
    return { name: record.name };
  }
  if (
    keys.length !== 2 ||
    keys[0] !== "name" ||
    keys[1] !== "parentId" ||
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    typeof record.parentId !== "string" ||
    record.parentId.length === 0
  ) {
    return null;
  }
  return { name: record.name, parentId: record.parentId };
}

function invalidSuggestionFallback(): SuggestedAction {
  return {
    confidence: 0,
    desiredState: {},
    evidenceIds: [],
    reasonCode: "PLANNER.INVALID_ACTION",
    type: "NEEDS_REVIEW",
  };
}

function parseSuggestion(candidate: PlanningCandidate): {
  invalid: boolean;
  suggestion: SuggestedAction;
  validated: ReasoningSuggestion | null;
} {
  try {
    const cloned = safeJsonClone(candidate.reasoning.suggestion);
    const result = ReasoningSuggestionSchema.safeParse(cloned);
    if (!result.success) {
      return {
        invalid: true,
        suggestion: invalidSuggestionFallback(),
        validated: null,
      };
    }
    return {
      invalid: false,
      suggestion: {
        confidence: result.data.confidence,
        desiredState: result.data.desiredState,
        evidenceIds: uniqueSorted(result.data.evidenceIds),
        reasonCode: result.data.reasonCode,
        type: result.data.actionType,
      },
      validated: result.data,
    };
  } catch {
    return {
      invalid: true,
      suggestion: invalidSuggestionFallback(),
      validated: null,
    };
  }
}

function questionBlockers(
  candidate: PlanningCandidate,
  suggestion: ReasoningSuggestion,
  targetId: string,
  policyVersion: string,
): MutableBlocker[] {
  const supplied = new Map(
    candidate.questions.map((question) => [
      question.questionKey,
      question.resolution,
    ]),
  );
  const blockers: MutableBlocker[] = [];
  for (const question of suggestion.unresolvedQuestions) {
    const resolution = supplied.get(question.questionKey);
    if (
      resolution?.status !== "RESOLVED" ||
      resolution.shouldAsk ||
      resolution.decision.questionKey !== question.questionKey ||
      resolution.decision.policyVersion !== policyVersion
    ) {
      blockers.push(
        blocker(
          "UNRESOLVED_QUESTION",
          `Question ${question.questionKey} needs a compatible human decision.`,
          {
            evidenceIds: question.evidenceIds,
            targetIds: [targetId],
          },
        ),
      );
    }
  }
  for (const question of candidate.questions) {
    if (
      question.resolution.status !== "RESOLVED" ||
      question.resolution.shouldAsk ||
      question.resolution.decision.questionKey !== question.questionKey ||
      question.resolution.decision.policyVersion !== policyVersion
    ) {
      blockers.push(
        blocker(
          "UNRESOLVED_QUESTION",
          `Question ${question.questionKey} is not resolved for this scope.`,
          { targetIds: [targetId] },
        ),
      );
    }
  }
  return blockers;
}

function prepareCandidate(
  candidate: PlanningCandidate,
  observedById: ReadonlyMap<string, ObservedItem>,
  input: Pick<BuildChangePlanInput, "policyVersion" | "scanGeneration">,
): CandidateAction {
  const targetId = candidate.evidence.bundle.targetId;
  const target = observedById.get(targetId) ?? null;
  const parsed = parseSuggestion(candidate);
  let suggested = parsed.suggestion;
  const directBlockers: MutableBlocker[] = [];
  const add = (
    code: PlanBlockerCode,
    message: string,
    evidenceIds: readonly string[] = suggested.evidenceIds,
  ) => {
    directBlockers.push(
      blocker(code, message, { evidenceIds, targetIds: [targetId] }),
    );
  };

  if (parsed.invalid) {
    add(
      "INVALID_ACTION",
      `Target ${targetId} has an invalid action contract.`,
      [],
    );
  }
  if (candidate.reasoning.status !== "VALIDATED") {
    suggested = invalidSuggestionFallback();
    add(
      "INVALID_ACTION",
      `Target ${targetId} has no validated model suggestion.`,
      [],
    );
  }
  if (
    candidate.evidence.policyVersion !== input.policyVersion ||
    candidate.evidence.scanGeneration !== input.scanGeneration ||
    (target !== null && target.scanGeneration !== input.scanGeneration)
  ) {
    suggested = invalidSuggestionFallback();
    add(
      "VERSION_MISMATCH",
      `Target ${targetId} does not match the plan policy version or scan generation.`,
      [],
    );
  }
  if (target === null || target.trashed) {
    suggested = invalidSuggestionFallback();
    add(
      "TARGET_ABSENT",
      `Target ${targetId} is absent from live observed state.`,
      [],
    );
  }

  const originalSuggestion = parsed.validated;
  if (originalSuggestion !== null) {
    directBlockers.push(
      ...questionBlockers(
        candidate,
        originalSuggestion,
        targetId,
        input.policyVersion,
      ),
    );
  }

  const currentEvidenceIds = new Set(
    candidate.evidence.bundle.observedFacts.map((fact) => fact.id),
  );
  if (
    suggested.type !== "NEEDS_REVIEW" &&
    (suggested.evidenceIds.length === 0 ||
      suggested.evidenceIds.some((id) => !currentEvidenceIds.has(id)))
  ) {
    add(
      "MATERIAL_EVIDENCE_MISSING",
      `Target ${targetId} does not have every cited evidence fact in the current bundle.`,
      suggested.evidenceIds,
    );
  }
  if (
    candidate.evidence.reviewState === "NEEDS_REVIEW" &&
    candidate.evidence.bundle.conflicts.every((conflict) => !conflict.material)
  ) {
    add(
      "MATERIAL_EVIDENCE_CONFLICT",
      `Target ${targetId} has material evidence that is not deterministic.`,
    );
  }

  const materialConflicts = candidate.evidence.bundle.conflicts.filter(
    (conflict) => conflict.material,
  );
  for (const conflict of materialConflicts) {
    const code =
      conflict.code === "PROTECTED_TARGET"
        ? "PROTECTED_ITEM"
        : conflict.code.startsWith("ARCHIVE_")
          ? "ARCHIVE_PRESERVATION"
          : "MATERIAL_EVIDENCE_CONFLICT";
    add(code, conflict.message);
  }

  if (candidate.evidence.context.protected.flags.length > 0) {
    suggested = {
      ...suggested,
      desiredState: {},
      reasonCode: candidate.evidence.context.protected.reasonCode,
      type: "NEEDS_REVIEW",
    };
    add(
      "PROTECTED_ITEM",
      `Target ${targetId} is protected and cannot enter an effective write list.`,
    );
  }
  if (
    candidate.evidence.context.archive.actionType === "PRESERVE_ARCHIVE" &&
    suggested.type !== "PRESERVE_ARCHIVE"
  ) {
    suggested = {
      ...suggested,
      desiredState: target === null ? {} : { parentIds: target.parentIds },
      reasonCode: candidate.evidence.context.archive.reasonCode,
      type: "PRESERVE_ARCHIVE",
    };
    add(
      "ARCHIVE_PRESERVATION",
      `Target ${targetId} must preserve its archive hierarchy.`,
    );
  }
  if (directBlockers.some((entry) => entry.code === "UNRESOLVED_QUESTION")) {
    suggested = {
      ...suggested,
      desiredState: {},
      reasonCode: "PLANNER.UNRESOLVED_QUESTION",
      type: "NEEDS_REVIEW",
    };
  }

  const desiredState = desiredStateFor(
    suggested.type,
    suggested.desiredState,
    target,
  );
  if (desiredState === null) {
    suggested = invalidSuggestionFallback();
    add(
      "INVALID_ACTION",
      `Target ${targetId} has unsupported desired-state fields for its action type.`,
    );
  }
  const safeDesired =
    desiredStateFor(suggested.type, suggested.desiredState, target) ?? {};
  const planIdentity = `${input.scanGeneration}\u0000${input.policyVersion}`;
  const actionId = createActionId({
    desiredState: safeDesired,
    planIdentity,
    targetId,
    type: suggested.type,
  });
  const action = ProposedActionSchema.parse({
    actionId,
    confidence: suggested.confidence,
    desiredState: safeDesired,
    evidenceIds: uniqueSorted([
      ...suggested.evidenceIds,
      ...candidate.questions.flatMap((question) =>
        question.resolution.status === "RESOLVED"
          ? [question.resolution.decision.decisionId]
          : [],
      ),
    ]),
    policyVersion: input.policyVersion,
    preconditions: actionPreconditions(
      suggested.type,
      target,
      safeDesired,
      observedById,
    ),
    reasonCode: suggested.reasonCode,
    reviewState:
      suggested.type === "NEEDS_REVIEW" || directBlockers.length > 0
        ? "Blocked"
        : "Pending",
    scanGeneration: input.scanGeneration,
    targetId,
    type: suggested.type,
  });
  for (const entry of directBlockers) entry.actionIds = [actionId];
  return { action, candidate, directBlockers, target };
}

function normalizedName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function sharesParent(left: ObservedItem, right: ObservedItem): boolean {
  const rightParents = new Set(right.parentIds);
  return left.parentIds.some((parentId) => rightParents.has(parentId));
}

function isDescendant(
  itemId: string,
  ancestorId: string,
  observedById: ReadonlyMap<string, ObservedItem>,
): boolean {
  const pending = [itemId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === ancestorId) return true;
    visited.add(current);
    const item = observedById.get(current);
    if (item !== undefined) pending.push(...item.parentIds);
  }
  return false;
}

function validateWholePlan(
  candidateActions: readonly CandidateAction[],
  observedItems: readonly ObservedItem[],
  observedById: ReadonlyMap<string, ObservedItem>,
): MutableBlocker[] {
  const blockers = candidateActions.flatMap((entry) => entry.directBlockers);
  const actions = candidateActions.map((entry) => entry.action);

  for (const entry of candidateActions) {
    const { action, candidate, target } = entry;
    const sourcePermissionGap =
      target !== null &&
      WRITE_ACTION_TYPES.includes(
        action.type as (typeof WRITE_ACTION_TYPES)[number],
      ) &&
      (!target.permissions.canRead ||
        (action.type === "RENAME" && !target.permissions.canWrite));
    if (sourcePermissionGap) {
      blockers.push(
        blocker(
          "PERMISSION_GAP",
          `Target ${target.id} does not have verified read and write permission.`,
          {
            actionIds: [action.actionId],
            evidenceIds: action.evidenceIds,
            targetIds: [target.id],
          },
        ),
      );
    }
    if (action.type === "RENAME" && target !== null) {
      const desiredName = action.desiredState.name;
      if (typeof desiredName === "string") {
        const collision = observedItems.find(
          (other) =>
            other.id !== target.id &&
            !other.trashed &&
            sharesParent(target, other) &&
            normalizedName(other.name) === normalizedName(desiredName),
        );
        if (collision !== undefined) {
          blockers.push(
            blocker(
              "NAME_COLLISION",
              `Rename for ${target.id} collides with ${collision.id} in a shared parent.`,
              {
                actionIds: [action.actionId],
                evidenceIds: action.evidenceIds,
                targetIds: [target.id, collision.id],
              },
            ),
          );
        }
      }
    }
    if (action.type === "CREATE_SHORTCUT") {
      const parentId = action.desiredState.parentId;
      const parent =
        typeof parentId === "string" ? observedById.get(parentId) : undefined;
      if (parent === undefined || parent.mimeType !== FolderMimeType) {
        blockers.push(
          blocker(
            "TARGET_ABSENT",
            `Shortcut destination ${typeof parentId === "string" ? parentId : "[invalid]"} is not an observed folder.`,
            {
              actionIds: [action.actionId],
              evidenceIds: action.evidenceIds,
              targetIds: [action.targetId],
            },
          ),
        );
      } else {
        if (!parent.permissions.canRead || !parent.permissions.canWrite) {
          blockers.push(
            blocker(
              "PERMISSION_GAP",
              `Shortcut destination ${parent.id} does not have verified read and write permission.`,
              {
                actionIds: [action.actionId],
                evidenceIds: action.evidenceIds,
                targetIds: [action.targetId, parent.id],
              },
            ),
          );
        }
        if (target?.mimeType === ShortcutMimeType) {
          blockers.push(
            blocker(
              "SHORTCUT_CYCLE",
              `Target ${action.targetId} is already a shortcut and cannot be used as a shortcut source.`,
              {
                actionIds: [action.actionId],
                evidenceIds: action.evidenceIds,
                targetIds: [action.targetId],
              },
            ),
          );
        }
        const existing = observedItems.filter(
          (item) =>
            item.mimeType === ShortcutMimeType &&
            item.shortcutTargetId === action.targetId &&
            item.parentIds.includes(parent.id),
        );
        const planned = actions.filter(
          (other) =>
            other.type === "CREATE_SHORTCUT" &&
            other.targetId === action.targetId &&
            other.desiredState.parentId === parent.id,
        );
        const limit =
          candidate.maxShortcutsPerSource === undefined
            ? 1
            : candidate.maxShortcutsPerSource;
        const allForSource =
          observedItems.filter(
            (item) =>
              item.mimeType === ShortcutMimeType &&
              item.shortcutTargetId === action.targetId,
          ).length +
          actions.filter(
            (other) =>
              other.type === "CREATE_SHORTCUT" &&
              other.targetId === action.targetId,
          ).length;
        if (
          existing.length > 0 ||
          planned.length > 1 ||
          (limit !== null && allForSource > limit)
        ) {
          blockers.push(
            blocker(
              "DUPLICATE_SHORTCUT",
              `Shortcut for ${action.targetId} would duplicate or exceed its allowed destinations.`,
              {
                actionIds: planned.map(
                  (plannedAction) => plannedAction.actionId,
                ),
                evidenceIds: action.evidenceIds,
                targetIds: [action.targetId, parent.id],
              },
            ),
          );
        }
        if (
          parent.id === action.targetId ||
          isDescendant(parent.id, action.targetId, observedById)
        ) {
          blockers.push(
            blocker(
              "SHORTCUT_CYCLE",
              `Shortcut for ${action.targetId} would point into its own hierarchy.`,
              {
                actionIds: [action.actionId],
                evidenceIds: action.evidenceIds,
                targetIds: [action.targetId, parent.id],
              },
            ),
          );
        }
      }
    }
    if (action.type === "NEEDS_REVIEW") {
      blockers.push(
        blocker(
          "NEEDS_REVIEW_ACTION",
          `Target ${action.targetId} still needs human review.`,
          {
            actionIds: [action.actionId],
            evidenceIds: action.evidenceIds,
            targetIds: [action.targetId],
          },
        ),
      );
    }
  }

  const actionsById = new Map<string, ProposedAction[]>();
  for (const action of actions) {
    const entries = actionsById.get(action.actionId) ?? [];
    entries.push(action);
    actionsById.set(action.actionId, entries);
  }
  for (const duplicates of actionsById.values()) {
    if (duplicates.length <= 1) continue;
    const action = duplicates[0];
    if (action === undefined) continue;
    blockers.push(
      blocker(
        "INVALID_ACTION",
        `Action ${action.actionId} occurs more than once in the plan.`,
        {
          actionIds: [action.actionId],
          evidenceIds: duplicates.flatMap((entry) => entry.evidenceIds),
          targetIds: [action.targetId],
        },
      ),
    );
  }

  const plannedNames = new Map<string, ProposedAction[]>();
  for (const action of actions) {
    if (action.type !== "RENAME") continue;
    const target = observedById.get(action.targetId);
    const desiredName = action.desiredState.name;
    if (target === undefined || typeof desiredName !== "string") continue;
    for (const parentId of target.parentIds) {
      const key = `${parentId}\u0000${normalizedName(desiredName)}`;
      const entries = plannedNames.get(key) ?? [];
      entries.push(action);
      plannedNames.set(key, entries);
    }
  }
  for (const [key, colliding] of plannedNames) {
    if (new Set(colliding.map((action) => action.targetId)).size <= 1) continue;
    const parentId = key.slice(0, key.indexOf("\u0000"));
    blockers.push(
      blocker(
        "NAME_COLLISION",
        `Multiple planned names collide in parent ${parentId}.`,
        {
          actionIds: colliding.map((action) => action.actionId),
          evidenceIds: colliding.flatMap((action) => action.evidenceIds),
          targetIds: colliding.map((action) => action.targetId),
        },
      ),
    );
  }

  const desiredByTargetAndType = new Map<
    string,
    Map<string, ProposedAction[]>
  >();
  for (const action of actions.filter((entry) => entry.type === "RENAME")) {
    const key = `${action.targetId}\u0000${action.type}`;
    const desiredKey = stableJson(action.desiredState);
    const variants =
      desiredByTargetAndType.get(key) ?? new Map<string, ProposedAction[]>();
    const entries = variants.get(desiredKey) ?? [];
    entries.push(action);
    variants.set(desiredKey, entries);
    desiredByTargetAndType.set(key, variants);
  }
  for (const [key, variants] of desiredByTargetAndType) {
    if (variants.size <= 1) continue;
    const targetId = key.slice(0, key.indexOf("\u0000"));
    const conflicting = [...variants.values()].flat();
    blockers.push(
      blocker(
        "CONTRADICTORY_DESIRED_STATE",
        `Target ${targetId} has contradictory desired states.`,
        {
          actionIds: conflicting.map((action) => action.actionId),
          evidenceIds: conflicting.flatMap((action) => action.evidenceIds),
          targetIds: [targetId],
        },
      ),
    );
  }

  const unique = new Map<string, MutableBlocker>();
  for (const entry of blockers) {
    const key = stableJson({
      actionIds: uniqueSorted(entry.actionIds),
      code: entry.code,
      evidenceIds: uniqueSorted(entry.evidenceIds),
      targetIds: uniqueSorted(entry.targetIds),
    });
    if (!unique.has(key)) {
      unique.set(
        key,
        blocker(entry.code, entry.message, {
          actionIds: entry.actionIds,
          evidenceIds: entry.evidenceIds,
          targetIds: entry.targetIds,
        }),
      );
    }
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(
        left.targetIds.join("\u0000"),
        right.targetIds.join("\u0000"),
      ) ||
      compareText(
        left.actionIds.join("\u0000"),
        right.actionIds.join("\u0000"),
      ),
  );
}

function actionRank(type: ActionType): number {
  const ranks: Record<ActionType, number> = {
    KEEP: 0,
    PRESERVE_ARCHIVE: 0,
    RENAME: 1,
    CREATE_SHORTCUT: 2,
    NEEDS_REVIEW: 3,
  };
  return ranks[type];
}

function sortActions(actions: readonly ProposedAction[]): ProposedAction[] {
  return [...actions].sort(
    (left, right) =>
      actionRank(left.type) - actionRank(right.type) ||
      compareText(left.targetId, right.targetId) ||
      compareText(left.actionId, right.actionId),
  );
}

function explanation(action: ProposedAction): ActionExplanation {
  if (action.type === "KEEP") {
    return {
      actionId: action.actionId,
      summary: `Keep ${action.targetId}. No write is needed because the observed state already satisfies ${action.reasonCode}.`,
      writeRequired: false,
    };
  }
  if (action.type === "PRESERVE_ARCHIVE") {
    return {
      actionId: action.actionId,
      summary: `Preserve ${action.targetId}. No write is needed; keep the archive hierarchy and its identity context.`,
      writeRequired: false,
    };
  }
  if (action.type === "NEEDS_REVIEW") {
    return {
      actionId: action.actionId,
      summary: `Review ${action.targetId}. Material evidence or authorization is unresolved.`,
      writeRequired: false,
    };
  }
  if (action.type === "RENAME") {
    const desiredName =
      typeof action.desiredState.name === "string"
        ? action.desiredState.name
        : "[invalid name]";
    return {
      actionId: action.actionId,
      summary: `Rename ${action.targetId} to ${desiredName} because ${action.reasonCode}.`,
      writeRequired: true,
    };
  }
  const parentId =
    typeof action.desiredState.parentId === "string"
      ? action.desiredState.parentId
      : "[invalid folder]";
  return {
    actionId: action.actionId,
    summary: `Create one shortcut for ${action.targetId} in ${parentId} because ${action.reasonCode}.`,
    writeRequired: true,
  };
}

function canonicalAuthorization(
  actions: readonly ProposedAction[],
  policyVersion: string,
  scanGeneration: string,
): Record<string, unknown> {
  return {
    actions: actions.map((action) => ({
      actionId: action.actionId,
      desiredState: action.desiredState,
      evidenceIds: uniqueSorted(action.evidenceIds),
      policyVersion: action.policyVersion,
      preconditions: action.preconditions,
      reasonCode: action.reasonCode,
      scanGeneration: action.scanGeneration,
      targetId: action.targetId,
      type: action.type,
    })),
    policyVersion,
    scanGeneration,
    schemaVersion: PLAN_HASH_CONTRACT.schemaVersion,
  };
}

export function buildChangePlan(input: BuildChangePlanInput): ChangePlan {
  const policyVersion = NonEmptyStringSchema.parse(input.policyVersion);
  const scanGeneration = NonEmptyStringSchema.parse(input.scanGeneration);
  const observedItems = input.observedItems.map((observed) => {
    const cloned = safeJsonClone(observed);
    return ObservedItemSchema.parse(cloned);
  });
  const observedById = new Map(
    observedItems.map((observed) => [observed.id, observed]),
  );
  const candidateActions = input.candidates.map((candidate) =>
    prepareCandidate(candidate, observedById, {
      policyVersion,
      scanGeneration,
    }),
  );
  const blockers = validateWholePlan(
    candidateActions,
    observedItems,
    observedById,
  );
  const blockedActionIds = new Set(
    blockers.flatMap((entry) => entry.actionIds),
  );
  const actions = sortActions(
    candidateActions.map(({ action }) =>
      blockedActionIds.has(action.actionId)
        ? ProposedActionSchema.parse({ ...action, reviewState: "Blocked" })
        : action,
    ),
  );
  const canonicalJson = stableJson(
    canonicalAuthorization(actions, policyVersion, scanGeneration),
  );
  const planHash = createHash("sha256").update(canonicalJson).digest("hex");
  const approvalEligible = blockers.length === 0;
  const result = ChangePlanSchema.parse({
    actions,
    approvalEligible,
    blockers,
    canonicalJson,
    effectiveActions: actions.filter(
      (action) =>
        WRITE_ACTION_TYPES.includes(
          action.type as (typeof WRITE_ACTION_TYPES)[number],
        ) && action.reviewState !== "Blocked",
    ),
    explanations: actions.map(explanation),
    hashContract: PLAN_HASH_CONTRACT.schemaVersion,
    planHash,
    policyVersion,
    scanGeneration,
  });
  if (result.actions.some((action) => !ACTION_TYPES.includes(action.type))) {
    throw new Error("Planner produced an unsupported action type.");
  }
  return deepFreeze(result);
}
