import { createHash } from "node:crypto";
import {
  ChangePlanSchema,
  type ChangePlan,
  type PlanBlocker,
} from "@dvw/change-planner";
import {
  DecisionScopeSchema,
  ProposedActionSchema,
  createActionId,
  type ActionType,
  type ProposedAction,
} from "@dvw/core";
import { z } from "zod";

export const FEEDBACK_PACKET_VERSION = "dvw.feedback.v1" as const;
export const FEEDBACK_DISPOSITIONS = [
  "Accept",
  "Reject",
  "Edit",
  "Ask",
] as const;

const MAX_PACKET_BYTES = 1024 * 1024;
const NonEmptyStringSchema = z.string().min(1);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IsoDateTimeSchema = z.iso.datetime({ offset: true });

function unsafeTextReason(value: string): string | null {
  if (/[<>]/u.test(value)) return "Markup is not allowed.";
  if (/javascript\s*:|data\s*:\s*text\/html|vbscript\s*:/iu.test(value)) {
    return "Executable URLs are not allowed.";
  }
  if (/\bon\p{L}+\s*=/iu.test(value)) {
    return "Executable event-handler text is not allowed.";
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      return "Control characters are not allowed.";
    }
  }
  return null;
}

function safeTextSchema(maximum: number) {
  return z
    .string()
    .max(maximum)
    .superRefine((value, context) => {
      const reason = unsafeTextReason(value);
      if (reason !== null)
        context.addIssue({ code: "custom", message: reason });
    });
}

const CommentSchema = safeTextSchema(4096);
const ReviewerSchema = safeTextSchema(200).pipe(z.string().trim().min(1));
const ReasonSchema = z.strictObject({
  code: safeTextSchema(120).pipe(
    z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_.-]*$/u),
  ),
  detail: CommentSchema,
});

const ProposedNameSchema = safeTextSchema(255)
  .nullable()
  .superRefine((value, context) => {
    if (value === null) return;
    if (value.trim().length === 0 || value !== value.normalize("NFC")) {
      context.addIssue({
        code: "custom",
        message: "A proposed name must be non-empty normalized text.",
      });
    }
    if (value === "." || value === ".." || /[/\\]/u.test(value)) {
      context.addIssue({
        code: "custom",
        message: "A proposed name cannot be a path.",
      });
    }
  });

export const ReviewFeedbackActionSchema = z
  .strictObject({
    actionId: NonEmptyStringSchema,
    comment: CommentSchema,
    disposition: z.enum(FEEDBACK_DISPOSITIONS),
    proposedName: ProposedNameSchema,
    reason: ReasonSchema,
  })
  .superRefine((value, context) => {
    if (value.disposition === "Edit" && value.proposedName === null) {
      context.addIssue({
        code: "custom",
        message: "Edit feedback requires one proposed name.",
        path: ["proposedName"],
      });
    }
    if (value.disposition !== "Edit" && value.proposedName !== null) {
      context.addIssue({
        code: "custom",
        message: "Only Edit feedback may carry a proposed name.",
        path: ["proposedName"],
      });
    }
  });

export const ReviewFeedbackQuestionSchema = z.strictObject({
  answer: z.json(),
  comment: CommentSchema,
  questionKey: NonEmptyStringSchema,
  scope: DecisionScopeSchema,
});

export const ReviewFeedbackDraftSchema = z.strictObject({
  actions: z.array(ReviewFeedbackActionSchema),
  globalComment: CommentSchema,
  questions: z.array(ReviewFeedbackQuestionSchema),
});

const PacketShape = {
  actions: z.array(ReviewFeedbackActionSchema),
  artifactVersion: NonEmptyStringSchema,
  checksum: DigestSchema,
  exportedAt: IsoDateTimeSchema,
  globalComment: CommentSchema,
  packetVersion: z.literal(FEEDBACK_PACKET_VERSION),
  planHash: DigestSchema,
  policyVersion: NonEmptyStringSchema,
  questions: z.array(ReviewFeedbackQuestionSchema),
  reviewer: ReviewerSchema,
  reviewRound: z.number().int().positive(),
  scanGeneration: NonEmptyStringSchema,
};

export const ReviewFeedbackPacketSchema = z
  .strictObject(PacketShape)
  .superRefine((value, context) => {
    const actionIds = value.actions.map((entry) => entry.actionId);
    if (new Set(actionIds).size !== actionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Action feedback IDs must be unique.",
        path: ["actions"],
      });
    }
    const questionKeys = value.questions.map((entry) => entry.questionKey);
    if (new Set(questionKeys).size !== questionKeys.length) {
      context.addIssue({
        code: "custom",
        message: "Question answers must be unique.",
        path: ["questions"],
      });
    }
  });

export type ReviewFeedbackAction = z.infer<typeof ReviewFeedbackActionSchema>;
export type ReviewFeedbackQuestion = z.infer<
  typeof ReviewFeedbackQuestionSchema
>;
export type ReviewFeedbackDraft = z.infer<typeof ReviewFeedbackDraftSchema>;
export type ReviewFeedbackPacket = z.infer<typeof ReviewFeedbackPacketSchema>;

export interface FeedbackReviewContext {
  readonly actions: readonly {
    readonly actionId: string;
    readonly type: ActionType;
  }[];
  readonly artifactVersion: string;
  readonly planHash: string;
  readonly policyVersion: string;
  readonly questions: readonly {
    readonly choices: readonly unknown[];
    readonly questionKey: string;
    readonly scope: z.infer<typeof DecisionScopeSchema>;
  }[];
  readonly reviewRound: number;
  readonly scanGeneration: string;
}

export interface FeedbackReplanReview {
  readonly artifactVersion: string;
  readonly nodes: readonly {
    readonly canRead: boolean;
    readonly canWrite: boolean;
    readonly id: string;
    readonly name: string;
    readonly parentIds: readonly string[];
    readonly protected: boolean;
  }[];
  readonly plan: ChangePlan;
  readonly questions: readonly {
    readonly choices: readonly unknown[];
    readonly questionKey: string;
    readonly scope: z.infer<typeof DecisionScopeSchema>;
  }[];
  readonly reviewRound: number;
}

export interface FeedbackDecisionCandidate {
  readonly answer: z.infer<typeof z.json>;
  readonly comment: string;
  readonly packetChecksum: string;
  readonly policyVersion: string;
  readonly questionKey: string;
  readonly reviewer: string;
  readonly scope: z.infer<typeof DecisionScopeSchema>;
}

export interface FeedbackPlannerInput {
  readonly comment: string;
  readonly disposition: (typeof FEEDBACK_DISPOSITIONS)[number];
  readonly proposedName: string | null;
  readonly reason: z.infer<typeof ReasonSchema>;
  readonly sourceActionId: string;
}

export interface FeedbackImportPreview {
  readonly acceptedFields: readonly string[];
  readonly ignoredFields: readonly string[];
  readonly rejectedFields: readonly string[];
}

export interface FeedbackReplanResult {
  readonly approvalGranted: false;
  readonly decisionCandidates: readonly FeedbackDecisionCandidate[];
  readonly packet: ReviewFeedbackPacket;
  readonly plan: ChangePlan;
  readonly plannerInputs: readonly FeedbackPlannerInput[];
  readonly preview: FeedbackImportPreview;
  readonly reviewRound: number;
  readonly sourcePlanHash: string;
}

export interface FeedbackValidationIssue {
  readonly code:
    | "CHECKSUM_MISMATCH"
    | "CONTEXT_MISMATCH"
    | "INCOMPLETE_PACKET"
    | "INVALID_JSON"
    | "INVALID_PACKET"
    | "UNKNOWN_ACTION"
    | "UNKNOWN_QUESTION";
  readonly message: string;
  readonly path: string;
}

export class FeedbackValidationError extends Error {
  public constructor(
    public readonly issues: readonly FeedbackValidationIssue[],
  ) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "FeedbackValidationError";
  }
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
  throw new TypeError("Feedback must contain JSON values only.");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function stableCompactJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function packetPayload(
  packet: ReviewFeedbackPacket,
): Omit<ReviewFeedbackPacket, "checksum"> {
  return Object.fromEntries(
    Object.entries(packet).filter(([key]) => key !== "checksum"),
  ) as Omit<ReviewFeedbackPacket, "checksum">;
}

export function feedbackChecksum(
  packet: Omit<ReviewFeedbackPacket, "checksum">,
): string {
  return createHash("sha256").update(canonicalJson(packet)).digest("hex");
}

export function hasValidFeedbackChecksum(
  packet: ReviewFeedbackPacket,
): boolean {
  return feedbackChecksum(packetPayload(packet)) === packet.checksum;
}

function issue(
  code: FeedbackValidationIssue["code"],
  path: string,
  message: string,
): FeedbackValidationIssue {
  return { code, message, path };
}

function pathOf(parts: readonly PropertyKey[]): string {
  return parts.map(String).join(".") || "packet";
}

function validateContext(
  packet: ReviewFeedbackPacket,
  context: FeedbackReviewContext,
): FeedbackValidationIssue[] {
  const issues: FeedbackValidationIssue[] = [];
  for (const [field, actual, expected] of [
    ["artifactVersion", packet.artifactVersion, context.artifactVersion],
    ["planHash", packet.planHash, context.planHash],
    ["scanGeneration", packet.scanGeneration, context.scanGeneration],
    ["policyVersion", packet.policyVersion, context.policyVersion],
    ["reviewRound", packet.reviewRound, context.reviewRound],
  ] as const) {
    if (actual !== expected) {
      issues.push(
        issue(
          "CONTEXT_MISMATCH",
          field,
          `Expected ${String(expected)} for this review, received ${String(actual)}.`,
        ),
      );
    }
  }

  const knownActions = new Map(
    context.actions.map((entry) => [entry.actionId, entry]),
  );
  for (const [index, action] of packet.actions.entries()) {
    const known = knownActions.get(action.actionId);
    if (known === undefined) {
      issues.push(
        issue(
          "UNKNOWN_ACTION",
          `actions.${index}.actionId`,
          `Action ${action.actionId} is not in this plan.`,
        ),
      );
    } else if (action.disposition === "Edit" && known.type !== "RENAME") {
      issues.push(
        issue(
          "INVALID_PACKET",
          `actions.${index}.proposedName`,
          "Only a rename proposal can accept a replacement name.",
        ),
      );
    }
  }
  if (
    packet.actions.length !== knownActions.size ||
    packet.actions.some((entry) => !knownActions.has(entry.actionId))
  ) {
    issues.push(
      issue(
        "INCOMPLETE_PACKET",
        "actions",
        "Feedback must name every known action exactly once.",
      ),
    );
  }

  const knownQuestions = new Map(
    context.questions.map((entry) => [entry.questionKey, entry]),
  );
  for (const [index, answer] of packet.questions.entries()) {
    const known = knownQuestions.get(answer.questionKey);
    if (known === undefined) {
      issues.push(
        issue(
          "UNKNOWN_QUESTION",
          `questions.${index}.questionKey`,
          `Question ${answer.questionKey} is not in this review.`,
        ),
      );
      continue;
    }
    if (canonicalJson(answer.scope) !== canonicalJson(known.scope)) {
      issues.push(
        issue(
          "CONTEXT_MISMATCH",
          `questions.${index}.scope`,
          "The answer scope does not match the reviewed question.",
        ),
      );
    }
    if (
      !known.choices.some(
        (choice) => canonicalJson(choice) === canonicalJson(answer.answer),
      )
    ) {
      issues.push(
        issue(
          "INVALID_PACKET",
          `questions.${index}.answer`,
          "The answer is not one of the reviewed choices.",
        ),
      );
    }
  }
  if (
    packet.questions.length !== knownQuestions.size ||
    packet.questions.some((entry) => !knownQuestions.has(entry.questionKey))
  ) {
    issues.push(
      issue(
        "INCOMPLETE_PACKET",
        "questions",
        "Feedback must answer every known material question exactly once.",
      ),
    );
  }
  return issues;
}

function validateNestedText(
  value: unknown,
  path: readonly PropertyKey[] = [],
): FeedbackValidationIssue[] {
  if (typeof value === "string") {
    const reason = unsafeTextReason(value);
    return reason === null
      ? []
      : [issue("INVALID_PACKET", pathOf(path), reason)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      validateNestedText(entry, [...path, index]),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      validateNestedText(entry, [...path, key]),
    );
  }
  return [];
}

export function createReviewFeedbackPacket(
  context: FeedbackReviewContext,
  rawDraft: ReviewFeedbackDraft,
  metadata: { readonly exportedAt: string; readonly reviewer: string },
): ReviewFeedbackPacket {
  const draftResult = ReviewFeedbackDraftSchema.safeParse(rawDraft);
  if (!draftResult.success) {
    throw new FeedbackValidationError(
      draftResult.error.issues.map((entry) =>
        issue("INVALID_PACKET", pathOf(entry.path), entry.message),
      ),
    );
  }
  const payload = {
    ...draftResult.data,
    artifactVersion: context.artifactVersion,
    exportedAt: metadata.exportedAt,
    packetVersion: FEEDBACK_PACKET_VERSION,
    planHash: context.planHash,
    policyVersion: context.policyVersion,
    reviewer: metadata.reviewer,
    reviewRound: context.reviewRound,
    scanGeneration: context.scanGeneration,
  };
  const packetResult = ReviewFeedbackPacketSchema.safeParse({
    ...payload,
    checksum: feedbackChecksum(payload),
  });
  if (!packetResult.success) {
    throw new FeedbackValidationError(
      packetResult.error.issues.map((entry) =>
        issue("INVALID_PACKET", pathOf(entry.path), entry.message),
      ),
    );
  }
  const contextIssues = validateContext(packetResult.data, context);
  const textIssues = validateNestedText(packetResult.data);
  if (contextIssues.length > 0 || textIssues.length > 0) {
    throw new FeedbackValidationError([...textIssues, ...contextIssues]);
  }
  return Object.freeze(packetResult.data);
}

export function parseReviewFeedbackPacket(
  text: string,
  context: FeedbackReviewContext,
): ReviewFeedbackPacket {
  const packetText = unwrapReviewFeedbackBlock(text);
  if (Buffer.byteLength(packetText, "utf8") > MAX_PACKET_BYTES) {
    throw new FeedbackValidationError([
      issue("INVALID_PACKET", "packet", "Feedback packet exceeds 1 MiB."),
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(packetText) as unknown;
  } catch {
    throw new FeedbackValidationError([
      issue("INVALID_JSON", "packet", "Feedback packet is not valid JSON."),
    ]);
  }
  const parsed = ReviewFeedbackPacketSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FeedbackValidationError(
      parsed.error.issues.map((entry) =>
        issue("INVALID_PACKET", pathOf(entry.path), entry.message),
      ),
    );
  }
  const issues = [
    ...validateNestedText(parsed.data),
    ...validateContext(parsed.data, context),
  ];
  const expectedChecksum = feedbackChecksum(packetPayload(parsed.data));
  if (expectedChecksum !== parsed.data.checksum) {
    issues.push(
      issue(
        "CHECKSUM_MISMATCH",
        "checksum",
        `Expected checksum ${expectedChecksum}, received ${parsed.data.checksum}.`,
      ),
    );
  }
  if (issues.length > 0) throw new FeedbackValidationError(issues);
  return Object.freeze(parsed.data);
}

export function unwrapReviewFeedbackBlock(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu);
  return fenced?.[1] ?? text;
}

export function serializeReviewFeedbackPacket(
  packet: ReviewFeedbackPacket,
): string {
  return canonicalJson(ReviewFeedbackPacketSchema.parse(packet));
}

export function feedbackContextFromReview(input: {
  readonly artifactVersion: string;
  readonly plan: Pick<
    ChangePlan,
    "actions" | "planHash" | "policyVersion" | "scanGeneration"
  >;
  readonly questions: readonly {
    readonly choices: readonly unknown[];
    readonly questionKey: string;
    readonly scope: z.infer<typeof DecisionScopeSchema>;
  }[];
  readonly reviewRound: number;
}): FeedbackReviewContext {
  return Object.freeze({
    actions: input.plan.actions.map((action) => ({
      actionId: action.actionId,
      type: action.type,
    })),
    artifactVersion: input.artifactVersion,
    planHash: input.plan.planHash,
    policyVersion: input.plan.policyVersion,
    questions: input.questions.map((question) => ({
      choices: question.choices,
      questionKey: question.questionKey,
      scope: question.scope,
    })),
    reviewRound: input.reviewRound,
    scanGeneration: input.plan.scanGeneration,
  });
}

function actionRank(type: ActionType): number {
  return {
    KEEP: 0,
    PRESERVE_ARCHIVE: 0,
    RENAME: 1,
    CREATE_SHORTCUT: 2,
    NEEDS_REVIEW: 3,
  }[type];
}

function sortActions(actions: readonly ProposedAction[]): ProposedAction[] {
  return [...actions].sort(
    (left, right) =>
      actionRank(left.type) - actionRank(right.type) ||
      compareText(left.targetId, right.targetId) ||
      compareText(left.actionId, right.actionId),
  );
}

function planExplanation(action: ProposedAction) {
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
  if (action.type === "CREATE_SHORTCUT") {
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
  if (action.type === "NEEDS_REVIEW") {
    return {
      actionId: action.actionId,
      summary: `Review ${action.targetId}. The reviewer requested clarification.`,
      writeRequired: false,
    };
  }
  return {
    actionId: action.actionId,
    summary: `${action.type === "KEEP" ? "Keep" : "Preserve"} ${action.targetId}; no write is required.`,
    writeRequired: false,
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
      evidenceIds: [...new Set(action.evidenceIds)].sort(compareText),
      policyVersion: action.policyVersion,
      preconditions: action.preconditions,
      reasonCode: action.reasonCode,
      scanGeneration: action.scanGeneration,
      targetId: action.targetId,
      type: action.type,
    })),
    policyVersion,
    scanGeneration,
    schemaVersion: "dvw.change-plan.v1",
  };
}

function feedbackBlocker(action: ProposedAction, message: string): PlanBlocker {
  const blockerId = `block_${createHash("sha256")
    .update(
      stableCompactJson({
        actionId: action.actionId,
        code: "NEEDS_REVIEW_ACTION",
        message,
      }),
    )
    .digest("hex")
    .slice(0, 32)}`;
  return {
    actionIds: [action.actionId],
    blockerId,
    code: "NEEDS_REVIEW_ACTION",
    evidenceIds: [...action.evidenceIds],
    message,
    targetIds: [action.targetId],
  };
}

function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      leafPaths(
        entry,
        prefix.length === 0 ? String(index) : `${prefix}.${index}`,
      ),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPaths(entry, prefix.length === 0 ? key : `${prefix}.${key}`),
    );
  }
  return [prefix];
}

export function replanFromReviewFeedback(
  review: FeedbackReplanReview,
  rawPacket: ReviewFeedbackPacket,
): FeedbackReplanResult {
  const context = feedbackContextFromReview(review);
  const packet = parseReviewFeedbackPacket(
    serializeReviewFeedbackPacket(rawPacket),
    context,
  );
  const feedbackByAction = new Map(
    packet.actions.map((entry) => [entry.actionId, entry]),
  );
  const actionIdChanges = new Map<string, string>();
  const newActions: ProposedAction[] = [];
  const additionalBlockers: PlanBlocker[] = [];

  for (const source of review.plan.actions) {
    const feedback = feedbackByAction.get(source.actionId);
    if (feedback === undefined) {
      throw new FeedbackValidationError([
        issue(
          "INCOMPLETE_PACKET",
          "actions",
          "Feedback must name every known action exactly once.",
        ),
      ]);
    }
    if (feedback.disposition === "Reject") continue;
    if (feedback.disposition === "Accept") {
      newActions.push(source);
      actionIdChanges.set(source.actionId, source.actionId);
      continue;
    }
    const type = feedback.disposition === "Ask" ? "NEEDS_REVIEW" : source.type;
    const desiredState =
      feedback.disposition === "Ask"
        ? {}
        : { name: feedback.proposedName as string };
    const actionId = createActionId({
      desiredState,
      planIdentity: `${source.scanGeneration}\u0000${source.policyVersion}`,
      targetId: source.targetId,
      type,
    });
    const changed = ProposedActionSchema.parse({
      ...source,
      actionId,
      desiredState,
      reasonCode:
        feedback.disposition === "Ask"
          ? "HUMAN_FEEDBACK.ASK"
          : `HUMAN_FEEDBACK.${feedback.reason.code}`,
      reviewState: feedback.disposition === "Ask" ? "Blocked" : "Pending",
      type,
    });
    newActions.push(changed);
    actionIdChanges.set(source.actionId, actionId);
    if (feedback.disposition === "Ask") {
      additionalBlockers.push(
        feedbackBlocker(
          changed,
          `Reviewer ${packet.reviewer} asked for clarification.`,
        ),
      );
    } else {
      additionalBlockers.push(
        feedbackBlocker(
          changed,
          "A feedback-requested edit must pass the normal planner again before it can become effective.",
        ),
      );
    }
  }

  const retainedTargetIds = new Set(
    newActions.map((action) => action.targetId),
  );
  const carriedBlockers = review.plan.blockers.flatMap((blocker) => {
    const actionIds = blocker.actionIds
      .map((actionId) => actionIdChanges.get(actionId))
      .filter((actionId): actionId is string => actionId !== undefined);
    const targetIds = blocker.targetIds.filter((targetId) =>
      retainedTargetIds.has(targetId),
    );
    if (blocker.actionIds.length > 0 && actionIds.length === 0) return [];
    if (blocker.targetIds.length > 0 && targetIds.length === 0) return [];
    return [{ ...blocker, actionIds, targetIds }];
  });
  const blockers = [...carriedBlockers, ...additionalBlockers].sort(
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
  const blockedIds = new Set(blockers.flatMap((blocker) => blocker.actionIds));
  const actions = sortActions(
    newActions.map((action) =>
      blockedIds.has(action.actionId)
        ? ProposedActionSchema.parse({ ...action, reviewState: "Blocked" })
        : action,
    ),
  );
  const canonicalJson = stableCompactJson(
    canonicalAuthorization(
      actions,
      review.plan.policyVersion,
      review.plan.scanGeneration,
    ),
  );
  const planHash = createHash("sha256").update(canonicalJson).digest("hex");
  const plan = ChangePlanSchema.parse({
    actions,
    approvalEligible: blockers.length === 0,
    blockers,
    canonicalJson,
    effectiveActions: actions.filter(
      (action) =>
        (action.type === "RENAME" || action.type === "CREATE_SHORTCUT") &&
        action.reviewState !== "Blocked",
    ),
    explanations: actions.map(planExplanation),
    hashContract: "dvw.change-plan.v1",
    planHash,
    policyVersion: review.plan.policyVersion,
    scanGeneration: review.plan.scanGeneration,
  });
  const decisionCandidates = packet.questions.map((answer) => ({
    answer: answer.answer,
    comment: answer.comment,
    packetChecksum: packet.checksum,
    policyVersion: packet.policyVersion,
    questionKey: answer.questionKey,
    reviewer: packet.reviewer,
    scope: answer.scope,
  }));
  const plannerInputs = packet.actions.map((action) => ({
    comment: action.comment,
    disposition: action.disposition,
    proposedName: action.proposedName,
    reason: action.reason,
    sourceActionId: action.actionId,
  }));
  return Object.freeze({
    approvalGranted: false as const,
    decisionCandidates,
    packet,
    plan,
    plannerInputs,
    preview: {
      acceptedFields: leafPaths(packet).sort(compareText),
      ignoredFields: [],
      rejectedFields: [],
    },
    reviewRound:
      plan.planHash === review.plan.planHash
        ? review.reviewRound
        : review.reviewRound + 1,
    sourcePlanHash: review.plan.planHash,
  });
}
