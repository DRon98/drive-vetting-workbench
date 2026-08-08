import type { ChangePlan } from "@dvw/change-planner";
import type { MutationProvider, ReadProvider } from "@dvw/core";
import type {
  DecisionMemoryStore,
  MaterialQuestion,
} from "@dvw/decision-memory";
import { LAB_SCENARIOS } from "@dvw/drive-simulator";
import type { EvidenceStore } from "@dvw/evidence-store-sqlite";
import {
  PilotPreflightResultSchema,
  PilotScorecardSchema,
} from "@dvw/reporting";
import { z } from "zod";

export const CLI_EXIT_CODES = Object.freeze({
  COVERAGE_GAP: 3,
  INTERNAL_FAILURE: 1,
  INVALID_INPUT: 4,
  REVIEW_REQUIRED: 2,
  SUCCESS: 0,
} as const);

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

const NonEmptyStringSchema = z.string().min(1);
const NullableContextSchema = z.object({
  policyVersion: NonEmptyStringSchema.nullable(),
  scanGeneration: NonEmptyStringSchema.nullable(),
});

const ScanOutputSchema = z.strictObject({
  command: z.literal("scan"),
  data: z.strictObject({
    deniedItemCount: z.number().int().nonnegative(),
    issueCount: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    providerId: NonEmptyStringSchema,
    published: z.literal(true),
    rootId: NonEmptyStringSchema,
    unsupportedTypeCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.enum(["COVERAGE_GAP", "SUCCESS"]),
});

const InventoryItemSchema = z.strictObject({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  id: NonEmptyStringSchema,
  mimeType: NonEmptyStringSchema,
  name: z.string(),
  parentIds: z.array(NonEmptyStringSchema),
  shortcutTargetId: NonEmptyStringSchema.nullable(),
  trashed: z.boolean(),
});

const InventoryOutputSchema = z.strictObject({
  command: z.literal("inventory"),
  data: z.strictObject({
    deniedItemCount: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative(),
    items: z.array(InventoryItemSchema),
    mode: z.enum(["search", "summary"]),
    query: z.string().nullable(),
    rootId: NonEmptyStringSchema,
    shortcutCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.literal("SUCCESS"),
});

const CliActionSchema = z.strictObject({
  actionId: NonEmptyStringSchema,
  reviewState: NonEmptyStringSchema,
  targetId: NonEmptyStringSchema,
  type: z.enum([
    "KEEP",
    "RENAME",
    "CREATE_SHORTCUT",
    "PRESERVE_ARCHIVE",
    "NEEDS_REVIEW",
  ]),
});

const CliBlockerSchema = z.strictObject({
  actionIds: z.array(NonEmptyStringSchema),
  code: NonEmptyStringSchema,
  targetIds: z.array(NonEmptyStringSchema),
});

const PlanOutputSchema = z.strictObject({
  command: z.literal("plan"),
  data: z.strictObject({
    actionCount: z.number().int().nonnegative(),
    actions: z.array(CliActionSchema),
    approvalEligible: z.boolean(),
    blockers: z.array(CliBlockerSchema),
    effectiveActionCount: z.number().int().nonnegative(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/u),
    questionCount: z.number().int().nonnegative(),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.enum(["REVIEW_REQUIRED", "SUCCESS"]),
});

const QuestionOutputItemSchema = z.strictObject({
  choices: z.array(z.json()),
  prompt: NonEmptyStringSchema,
  questionKey: NonEmptyStringSchema,
  scope: z.strictObject({
    id: NonEmptyStringSchema.nullable(),
    type: z.enum(["item", "folder", "deal", "document-type", "global"]),
  }),
});

const QuestionsOutputSchema = z.strictObject({
  command: z.literal("questions"),
  data: z.strictObject({
    questionCount: z.number().int().nonnegative(),
    questions: z.array(QuestionOutputItemSchema),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.enum(["REVIEW_REQUIRED", "SUCCESS"]),
});

const DecideOutputSchema = z.strictObject({
  command: z.literal("decide"),
  data: z.strictObject({
    decisionId: NonEmptyStringSchema,
    provenance: z.literal("HumanDecision"),
    questionKey: NonEmptyStringSchema,
    scope: z.strictObject({
      id: NonEmptyStringSchema.nullable(),
      type: z.enum(["item", "folder", "deal", "document-type", "global"]),
    }),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.literal("SUCCESS"),
});

const SnapshotHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const LabCommonDataShape = {
  labId: NonEmptyStringSchema,
  rootId: NonEmptyStringSchema,
  scenario: z.enum(LAB_SCENARIOS),
  snapshotHash: SnapshotHashSchema,
};
const LabDiffEntrySchema = z.strictObject({
  itemId: NonEmptyStringSchema,
  kind: z.enum(["ABSENT_FROM_CURRENT", "ADDED", "CHANGED"]),
});
const LabTreeEntrySchema = z.strictObject({
  depth: z.number().int().nonnegative(),
  id: NonEmptyStringSchema,
  name: z.string(),
  shortcutTargetId: NonEmptyStringSchema.nullable(),
});
const LabDataSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...LabCommonDataShape,
    baselineHash: SnapshotHashSchema,
    operation: z.literal("init"),
  }),
  z.strictObject({
    ...LabCommonDataShape,
    entries: z.array(LabTreeEntrySchema),
    operation: z.literal("tree"),
  }),
  z.strictObject({
    ...LabCommonDataShape,
    entries: z.array(LabDiffEntrySchema),
    operation: z.literal("edit"),
    previousSnapshotHash: SnapshotHashSchema,
  }),
  z.strictObject({
    ...LabCommonDataShape,
    baselineHash: SnapshotHashSchema,
    operation: z.literal("snapshot"),
  }),
  z.strictObject({
    ...LabCommonDataShape,
    entries: z.array(LabDiffEntrySchema),
    operation: z.literal("diff"),
    referenceSnapshotHash: SnapshotHashSchema,
  }),
  z.strictObject({
    ...LabCommonDataShape,
    baselineHash: SnapshotHashSchema,
    operation: z.literal("reset"),
    restoredExact: z.literal(true),
  }),
]);
const LabOutputSchema = z.strictObject({
  command: z.literal("lab"),
  data: LabDataSchema,
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.literal("SUCCESS"),
});

const ReviewOutputSchema = z.strictObject({
  command: z.literal("review"),
  data: z.strictObject({
    artifactPath: NonEmptyStringSchema,
    artifactSha256: SnapshotHashSchema,
    planHash: SnapshotHashSchema,
    reviewRound: z.number().int().positive(),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.literal("SUCCESS"),
});

const FeedbackOutputSchema = z.strictObject({
  command: z.literal("feedback"),
  data: z.strictObject({
    approvalGranted: z.literal(false),
    artifactPath: NonEmptyStringSchema,
    artifactSha256: SnapshotHashSchema,
    changed: z.boolean(),
    importedChecksum: SnapshotHashSchema,
    nextPlanHash: SnapshotHashSchema,
    nextReviewRound: z.number().int().positive(),
    sourcePlanHash: SnapshotHashSchema,
    sourceReviewRound: z.number().int().positive(),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.literal("SUCCESS"),
});

const ApprovalOutputSchema = z.strictObject({
  command: z.literal("approve"),
  data: z.strictObject({
    approvalChecksum: SnapshotHashSchema,
    approvedAt: z.iso.datetime({ offset: true }),
    approver: NonEmptyStringSchema,
    artifactPath: NonEmptyStringSchema,
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    planHash: SnapshotHashSchema,
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.literal("SUCCESS"),
});

const RenameRequestSchema = z.strictObject({
  expectedModifiedTime: z.iso.datetime({ offset: true }),
  name: z.string(),
  targetId: NonEmptyStringSchema,
});
const ShortcutRequestSchema = z.strictObject({
  name: z.string(),
  parentId: NonEmptyStringSchema,
  targetId: NonEmptyStringSchema,
});
const DryRunOperationSchema = z.strictObject({
  actionId: NonEmptyStringSchema,
  disposition: z.enum(["NoOp", "Write"]),
  reason: NonEmptyStringSchema,
  reasonCode: NonEmptyStringSchema,
  request: z.union([RenameRequestSchema, ShortcutRequestSchema]).nullable(),
  targetId: NonEmptyStringSchema,
  type: z.enum(["CREATE_SHORTCUT", "RENAME"]),
});
const DryRunIssueSchema = z.strictObject({
  actionId: NonEmptyStringSchema.nullable(),
  code: NonEmptyStringSchema,
  itemId: NonEmptyStringSchema.nullable(),
  message: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
});
const DryRunOutputSchema = z.strictObject({
  command: z.literal("dry-run"),
  data: z.strictObject({
    approvalChecksum: SnapshotHashSchema,
    checkedAt: z.iso.datetime({ offset: true }),
    issueCount: z.number().int().nonnegative(),
    issues: z.array(DryRunIssueSchema),
    operationCount: z.number().int().nonnegative(),
    operations: z.array(DryRunOperationSchema),
    planHash: SnapshotHashSchema,
    providerId: NonEmptyStringSchema,
    writeCount: z.literal(0),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.enum(["REVIEW_REQUIRED", "SUCCESS"]),
});

const ApplyResultSchema = z.strictObject({
  actionId: NonEmptyStringSchema,
  disposition: z.enum(["Failed", "MutationAccepted", "NoOp"]),
  failureCode: NonEmptyStringSchema.nullable(),
  targetId: NonEmptyStringSchema,
  type: z.enum(["CREATE_SHORTCUT", "RENAME"]),
  verification: z.enum(["Failed", "Verified"]),
});
const ApplyOutputSchema = z.strictObject({
  command: z.literal("apply"),
  data: z.strictObject({
    acceptedMutationCount: z.number().int().nonnegative(),
    approvalChecksum: SnapshotHashSchema,
    checkedAt: z.iso.datetime({ offset: true }),
    mutationCallCount: z.number().int().nonnegative(),
    planHash: SnapshotHashSchema,
    preflightIssueCount: z.number().int().nonnegative(),
    providerId: NonEmptyStringSchema,
    receiptCount: z.number().int().nonnegative(),
    resumeCursor: z.number().int().nonnegative(),
    results: z.array(ApplyResultSchema),
    runId: NonEmptyStringSchema,
    state: z.enum(["Completed", "Failed", "Partial"]),
    stoppedAtActionId: NonEmptyStringSchema.nullable(),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.enum(["REVIEW_REQUIRED", "SUCCESS"]),
});

const VerifyActionSchema = z.strictObject({
  actionId: NonEmptyStringSchema,
  failureCode: NonEmptyStringSchema.nullable(),
  liveStatus: z.enum(["Failed", "Verified"]),
  receiptStatus: z.enum(["Failed", "Verified"]).nullable(),
});
const VerifyOutputSchema = z.strictObject({
  command: z.literal("verify"),
  data: z.strictObject({
    failedActionCount: z.number().int().nonnegative(),
    planHash: SnapshotHashSchema,
    providerId: NonEmptyStringSchema,
    receiptCount: z.number().int().nonnegative(),
    results: z.array(VerifyActionSchema),
    runId: NonEmptyStringSchema,
    state: z.enum(["Completed", "Failed"]),
    verifiedActionCount: z.number().int().nonnegative(),
  }),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema,
  status: z.enum(["REVIEW_REQUIRED", "SUCCESS"]),
});

const PilotOutputSchema = z.strictObject({
  command: z.literal("pilot"),
  data: z.discriminatedUnion("operation", [
    z.strictObject({
      operation: z.literal("preflight"),
      result: PilotPreflightResultSchema,
    }),
    z.strictObject({
      artifactPath: NonEmptyStringSchema,
      artifactSha256: SnapshotHashSchema,
      feedbackPacketPath: NonEmptyStringSchema,
      operation: z.literal("scorecard"),
      reviewArtifactPath: NonEmptyStringSchema,
      scorecard: PilotScorecardSchema,
    }),
  ]),
  policyVersion: NonEmptyStringSchema,
  scanGeneration: NonEmptyStringSchema.nullable(),
  status: z.enum(["REVIEW_REQUIRED", "SUCCESS"]),
});

const ErrorOutputSchema = z
  .strictObject({
    command: z.literal("error"),
    data: z.strictObject({
      code: z.enum(["INTERNAL_FAILURE", "INVALID_INPUT"]),
      message: NonEmptyStringSchema,
      requestedCommand: z.string().nullable(),
    }),
    status: z.enum(["INTERNAL_FAILURE", "INVALID_INPUT"]),
  })
  .extend(NullableContextSchema.shape);

export const CliOutputSchema = z.discriminatedUnion("command", [
  ScanOutputSchema,
  InventoryOutputSchema,
  PlanOutputSchema,
  QuestionsOutputSchema,
  DecideOutputSchema,
  LabOutputSchema,
  ReviewOutputSchema,
  FeedbackOutputSchema,
  ApprovalOutputSchema,
  DryRunOutputSchema,
  ApplyOutputSchema,
  VerifyOutputSchema,
  PilotOutputSchema,
  ErrorOutputSchema,
]);

export type CliOutput = z.infer<typeof CliOutputSchema>;
export type CliCommandOutput = Exclude<CliOutput, { command: "error" }>;

export interface SelectedReadProvider {
  readonly providerId: string;
  readonly read: ReadProvider;
}

export interface ReadProviderSelector {
  select(input: { readonly providerId: string }): Promise<SelectedReadProvider>;
}

export interface SelectedExecutionProvider extends SelectedReadProvider {
  readonly mutation: MutationProvider;
}

export interface ExecutionProviderSelector {
  select(input: {
    readonly providerId: string;
  }): Promise<SelectedExecutionProvider>;
}

export interface CliPlanningWorkflow {
  build(input: {
    readonly decisions: DecisionMemoryStore;
    readonly policyVersion: string;
    readonly scanGeneration: string;
    readonly store: EvidenceStore;
  }): Promise<{
    readonly plan: ChangePlan;
    readonly questions: readonly MaterialQuestion[];
  }>;
}

export interface CliRuntime {
  readonly artifactsRoot: string;
  readonly databasePath: string;
  readonly defaultProviderId: string;
  readonly executionProviders?: ExecutionProviderSelector;
  readonly generationId: (rootId: string) => string;
  readonly now: () => string;
  readonly planning: CliPlanningWorkflow;
  readonly policyVersion: string;
  readonly providers: ReadProviderSelector;
}

export interface CliRunResult {
  readonly exitCode: CliExitCode;
  readonly output: CliOutput;
  readonly text: string;
}
