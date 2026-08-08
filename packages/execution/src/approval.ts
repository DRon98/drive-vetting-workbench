import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ChangePlanSchema,
  PLAN_HASH_CONTRACT,
  type ChangePlan,
} from "@dvw/change-planner";
import { createActionId, type ProposedAction } from "@dvw/core";
import { z } from "zod";

export const APPROVAL_ARTIFACT_VERSION = "dvw.approval.v1" as const;

const NonEmptyStringSchema = z.string().min(1);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const ApproverSchema = NonEmptyStringSchema.max(200).superRefine(
  (value, context) => {
    const hasUnsafeCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        character === "<" ||
        character === ">" ||
        codePoint < 32 ||
        (codePoint >= 127 && codePoint <= 159)
      );
    });
    if (hasUnsafeCharacter) {
      context.addIssue({
        code: "custom",
        message:
          "Approver identity cannot contain markup or control characters.",
      });
    }
  },
);

export const ApprovalArtifactSchema = z.strictObject({
  approvalVersion: z.literal(APPROVAL_ARTIFACT_VERSION),
  approvedAt: IsoDateTimeSchema,
  approver: ApproverSchema,
  checksum: DigestSchema,
  confirmation: NonEmptyStringSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
  planHash: DigestSchema,
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
});

export type ApprovalArtifact = z.infer<typeof ApprovalArtifactSchema>;

export interface ApprovalValidationIssue {
  readonly code:
    | "APPROVAL_EXPIRED"
    | "APPROVAL_MISMATCH"
    | "CHECKSUM_MISMATCH"
    | "CONFIRMATION_REQUIRED"
    | "INVALID_APPROVAL"
    | "INVALID_PLAN"
    | "PLAN_NOT_ELIGIBLE";
  readonly message: string;
  readonly path: string;
}

export class ApprovalValidationError extends Error {
  public constructor(
    public readonly issues: readonly ApprovalValidationIssue[],
  ) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "ApprovalValidationError";
  }
}

function issue(
  code: ApprovalValidationIssue["code"],
  path: string,
  message: string,
): ApprovalValidationIssue {
  return { code, message, path };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return typeof value === "string" ? value.normalize("NFC") : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key.normalize("NFC"), canonicalValue(entry)]),
    );
  }
  throw new TypeError("Approval values must be JSON data.");
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function stablePrettyJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function canonicalAuthorization(plan: ChangePlan): Record<string, unknown> {
  return {
    actions: plan.actions.map((action) => ({
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
    policyVersion: plan.policyVersion,
    scanGeneration: plan.scanGeneration,
    schemaVersion: PLAN_HASH_CONTRACT.schemaVersion,
  };
}

function actionRank(action: ProposedAction): number {
  return {
    KEEP: 0,
    PRESERVE_ARCHIVE: 0,
    RENAME: 1,
    CREATE_SHORTCUT: 2,
    NEEDS_REVIEW: 3,
  }[action.type];
}

export function validateCanonicalPlan(rawPlan: ChangePlan): ChangePlan {
  const parsed = ChangePlanSchema.safeParse(rawPlan);
  if (!parsed.success) {
    throw new ApprovalValidationError(
      parsed.error.issues.map((entry) =>
        issue(
          "INVALID_PLAN",
          entry.path.map(String).join(".") || "plan",
          entry.message,
        ),
      ),
    );
  }
  const plan = parsed.data;
  const issues: ApprovalValidationIssue[] = [];
  const expectedCanonicalJson = stableJson(canonicalAuthorization(plan));
  if (plan.canonicalJson !== expectedCanonicalJson) {
    issues.push(
      issue(
        "INVALID_PLAN",
        "plan.canonicalJson",
        "Canonical plan bytes do not match the typed action authorization fields.",
      ),
    );
  }
  const expectedHash = createHash("sha256")
    .update(expectedCanonicalJson)
    .digest("hex");
  if (plan.planHash !== expectedHash) {
    issues.push(
      issue(
        "INVALID_PLAN",
        "plan.planHash",
        `Expected canonical plan hash ${expectedHash}.`,
      ),
    );
  }
  for (const [index, action] of plan.actions.entries()) {
    const expectedActionId = createActionId({
      desiredState: action.desiredState,
      planIdentity: `${plan.scanGeneration}\u0000${plan.policyVersion}`,
      targetId: action.targetId,
      type: action.type,
    });
    if (
      action.actionId !== expectedActionId ||
      action.scanGeneration !== plan.scanGeneration ||
      action.policyVersion !== plan.policyVersion
    ) {
      issues.push(
        issue(
          "INVALID_PLAN",
          `plan.actions.${index}`,
          "Action identity or plan context does not match the canonical plan.",
        ),
      );
    }
  }
  const sorted = [...plan.actions].sort(
    (left, right) =>
      actionRank(left) - actionRank(right) ||
      compareText(left.targetId, right.targetId) ||
      compareText(left.actionId, right.actionId),
  );
  if (
    sorted.map((action) => action.actionId).join("\u0000") !==
    plan.actions.map((action) => action.actionId).join("\u0000")
  ) {
    issues.push(
      issue(
        "INVALID_PLAN",
        "plan.actions",
        "Canonical plan actions are not in deterministic execution order.",
      ),
    );
  }
  const expectedEffective = plan.actions.filter(
    (action) =>
      (action.type === "RENAME" || action.type === "CREATE_SHORTCUT") &&
      action.reviewState !== "Blocked",
  );
  const hasUnresolvedAction = plan.actions.some(
    (action) =>
      action.type === "NEEDS_REVIEW" || action.reviewState === "Blocked",
  );
  if (
    stableJson(expectedEffective) !== stableJson(plan.effectiveActions) ||
    plan.blockers.length > 0 ||
    !plan.approvalEligible ||
    hasUnresolvedAction
  ) {
    issues.push(
      issue(
        "PLAN_NOT_ELIGIBLE",
        "plan.approvalEligible",
        "Only a blocker-free eligible plan without unresolved actions and with an exact effective action list can be approved.",
      ),
    );
  }
  if (issues.length > 0) throw new ApprovalValidationError(issues);
  return deepFreeze(plan);
}

function approvalPayload(
  artifact: ApprovalArtifact,
): Omit<ApprovalArtifact, "checksum"> {
  return Object.fromEntries(
    Object.entries(artifact).filter(([key]) => key !== "checksum"),
  ) as Omit<ApprovalArtifact, "checksum">;
}

function approvalChecksum(payload: Omit<ApprovalArtifact, "checksum">): string {
  return createHash("sha256").update(stablePrettyJson(payload)).digest("hex");
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

export function createApprovalArtifact(
  rawPlan: ChangePlan,
  input: {
    readonly approvedAt: string;
    readonly approver: string;
    readonly confirmation: string;
    readonly expiresAt: string | null;
  },
): ApprovalArtifact {
  const plan = validateCanonicalPlan(rawPlan);
  const expectedConfirmation = `APPROVE ${plan.planHash}`;
  if (input.confirmation !== expectedConfirmation) {
    throw new ApprovalValidationError([
      issue(
        "CONFIRMATION_REQUIRED",
        "confirmation",
        `Explicit operator confirmation must equal ${expectedConfirmation}.`,
      ),
    ]);
  }
  const payload = {
    approvalVersion: APPROVAL_ARTIFACT_VERSION,
    approvedAt: input.approvedAt,
    approver: input.approver.normalize("NFC").trim(),
    confirmation: expectedConfirmation,
    expiresAt: input.expiresAt,
    planHash: plan.planHash,
    policyVersion: plan.policyVersion,
    scanGeneration: plan.scanGeneration,
  } as const;
  const parsed = ApprovalArtifactSchema.safeParse({
    ...payload,
    checksum: approvalChecksum(payload),
  });
  if (!parsed.success) {
    throw new ApprovalValidationError(
      parsed.error.issues.map((entry) =>
        issue(
          "INVALID_APPROVAL",
          entry.path.map(String).join(".") || "approval",
          entry.message,
        ),
      ),
    );
  }
  if (
    parsed.data.expiresAt !== null &&
    Date.parse(parsed.data.expiresAt) <= Date.parse(parsed.data.approvedAt)
  ) {
    throw new ApprovalValidationError([
      issue(
        "INVALID_APPROVAL",
        "expiresAt",
        "Approval expiry must be after approval time.",
      ),
    ]);
  }
  return deepFreeze(parsed.data);
}

export function parseApprovalArtifact(text: string): ApprovalArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new ApprovalValidationError([
      issue("INVALID_APPROVAL", "approval", "Approval is not valid JSON."),
    ]);
  }
  const parsed = ApprovalArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApprovalValidationError(
      parsed.error.issues.map((entry) =>
        issue(
          "INVALID_APPROVAL",
          entry.path.map(String).join(".") || "approval",
          entry.message,
        ),
      ),
    );
  }
  const expected = approvalChecksum(approvalPayload(parsed.data));
  if (expected !== parsed.data.checksum) {
    throw new ApprovalValidationError([
      issue(
        "CHECKSUM_MISMATCH",
        "checksum",
        `Expected approval checksum ${expected}.`,
      ),
    ]);
  }
  if (
    parsed.data.expiresAt !== null &&
    Date.parse(parsed.data.expiresAt) <= Date.parse(parsed.data.approvedAt)
  ) {
    throw new ApprovalValidationError([
      issue(
        "INVALID_APPROVAL",
        "expiresAt",
        "Approval expiry must be after approval time.",
      ),
    ]);
  }
  return deepFreeze(parsed.data);
}

export function serializeApprovalArtifact(artifact: ApprovalArtifact): string {
  const text = stablePrettyJson(ApprovalArtifactSchema.parse(artifact));
  parseApprovalArtifact(text);
  return text;
}

export function validateApprovalForPlan(
  rawApproval: ApprovalArtifact,
  rawPlan: ChangePlan,
  input: { readonly now: string },
): ApprovalArtifact {
  const plan = validateCanonicalPlan(rawPlan);
  const approval = parseApprovalArtifact(
    serializeApprovalArtifact(rawApproval),
  );
  const mismatches = [
    ["planHash", approval.planHash, plan.planHash],
    ["policyVersion", approval.policyVersion, plan.policyVersion],
    ["scanGeneration", approval.scanGeneration, plan.scanGeneration],
    ["confirmation", approval.confirmation, `APPROVE ${plan.planHash}`],
  ] as const;
  const issues = mismatches.flatMap(([path, actual, expected]) =>
    actual === expected
      ? []
      : [
          issue(
            "APPROVAL_MISMATCH",
            path,
            `Approval value ${actual} does not match plan value ${expected}.`,
          ),
        ],
  );
  const nowResult = IsoDateTimeSchema.safeParse(input.now);
  if (!nowResult.success) {
    issues.push(
      issue(
        "INVALID_APPROVAL",
        "now",
        "Current time must be an ISO timestamp.",
      ),
    );
  } else if (
    approval.expiresAt !== null &&
    Date.parse(nowResult.data) >= Date.parse(approval.expiresAt)
  ) {
    issues.push(
      issue(
        "APPROVAL_EXPIRED",
        "expiresAt",
        `Approval expired at ${approval.expiresAt}.`,
      ),
    );
  }
  if (issues.length > 0) throw new ApprovalValidationError(issues);
  return approval;
}

export function writeApprovalArtifactCreateOnly(
  path: string,
  artifact: ApprovalArtifact,
): void {
  const text = serializeApprovalArtifact(artifact);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    if (readFileSync(path, "utf8") !== text) {
      throw new Error(
        `Refusing to replace an existing approval artifact with different bytes: ${path}`,
      );
    }
  }
}
