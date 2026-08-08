import { z } from "zod";
import { ActionTypeSchema, RunStateSchema } from "./action-types.js";
import {
  ProposalReviewStateSchema,
  ScanGenerationStateSchema,
} from "./state-machines.js";

const NonEmptyStringSchema = z.string().min(1);
const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const JsonObjectSchema = z.record(z.string(), z.json());

export const EvidenceSourceSchema = z
  .enum([
    "Observed",
    "DeclaredContext",
    "HumanDecision",
    "Policy",
    "ModelSuggestion",
  ])
  .meta({ id: "EvidenceSource" });
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

const PermissionSummarySchema = z.strictObject({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  deniedReason: NonEmptyStringSchema.optional(),
});

export const ObservedItemSchema = z
  .strictObject({
    contentFingerprint: NonEmptyStringSchema.nullable(),
    createdTime: IsoDateTimeSchema,
    id: NonEmptyStringSchema,
    mimeType: NonEmptyStringSchema,
    modifiedTime: IsoDateTimeSchema,
    name: z.string(),
    parentIds: z.array(NonEmptyStringSchema),
    permissions: PermissionSummarySchema,
    scanGeneration: NonEmptyStringSchema,
    shortcutTargetId: NonEmptyStringSchema.nullable(),
    trashed: z.boolean(),
  })
  .meta({ id: "ObservedItem" });
export type ObservedItem = z.infer<typeof ObservedItemSchema>;

const CoverageIssueSchema = z.strictObject({
  itemId: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
});

const UnsupportedTypeSchema = z.strictObject({
  itemId: NonEmptyStringSchema,
  mimeType: NonEmptyStringSchema,
});

export const ScanCoverageSchema = z
  .strictObject({
    deniedItems: z.array(CoverageIssueSchema),
    exportsAttempted: z.number().int().nonnegative(),
    generationId: NonEmptyStringSchema,
    itemCount: z.number().int().nonnegative(),
    pageTokensConsumed: z.array(NonEmptyStringSchema),
    rootId: NonEmptyStringSchema,
    state: ScanGenerationStateSchema,
    unsupportedTypes: z.array(UnsupportedTypeSchema),
    warnings: z.array(NonEmptyStringSchema),
  })
  .meta({ id: "ScanCoverage" });
export type ScanCoverage = z.infer<typeof ScanCoverageSchema>;

const TaxonomyNodeSchema = z.strictObject({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  parentId: NonEmptyStringSchema.nullable(),
});
const NamingRuleSchema = z.strictObject({
  reasonCode: NonEmptyStringSchema,
  template: NonEmptyStringSchema,
});
const DocumentTypeSchema = z.strictObject({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
});
const EntityAliasSchema = z.strictObject({
  alias: NonEmptyStringSchema,
  entityId: NonEmptyStringSchema,
});
const ProtectedItemRuleSchema = z.strictObject({
  reasonCode: NonEmptyStringSchema,
  selector: NonEmptyStringSchema,
});
const ArchiveRuleSchema = z.strictObject({
  preserveHierarchy: z.boolean(),
  reasonCode: NonEmptyStringSchema,
  selector: NonEmptyStringSchema,
});
const ShortcutExceptionSchema = z.strictObject({
  id: NonEmptyStringSchema,
  maxPerSource: z.number().int().positive().nullable(),
  mode: NonEmptyStringSchema,
  reasonCode: NonEmptyStringSchema,
  selector: NonEmptyStringSchema,
});
const ShortcutRulesSchema = z.strictObject({
  exceptions: z.array(ShortcutExceptionSchema),
  maxPerSource: z.number().int().positive(),
});
const PolicyPrecedentSchema = z.strictObject({
  decision: NonEmptyStringSchema,
  key: NonEmptyStringSchema,
  scope: NonEmptyStringSchema,
});

export const PolicyPackSchema = z
  .strictObject({
    archiveRules: z.array(ArchiveRuleSchema),
    documentTypes: z.array(DocumentTypeSchema),
    entityAliases: z.array(EntityAliasSchema),
    namingRules: z.array(NamingRuleSchema),
    precedents: z.array(PolicyPrecedentSchema),
    protectedItems: z.array(ProtectedItemRuleSchema),
    shortcutRules: ShortcutRulesSchema,
    taxonomy: z.array(TaxonomyNodeSchema),
    version: NonEmptyStringSchema,
  })
  .meta({ id: "PolicyPack" });
export type PolicyPack = z.infer<typeof PolicyPackSchema>;

const EvidenceFactSchema = z.strictObject({
  field: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
  source: EvidenceSourceSchema,
  sourceLocator: NonEmptyStringSchema,
  value: z.json(),
});
const MatchedRuleSchema = z.strictObject({
  policyLocator: NonEmptyStringSchema,
  reasonCode: NonEmptyStringSchema,
});
const EntityCandidateSchema = z.strictObject({
  confidence: z.number().min(0).max(1),
  entityId: NonEmptyStringSchema,
});
const DocumentTypeCandidateSchema = z.strictObject({
  confidence: z.number().min(0).max(1),
  documentTypeId: NonEmptyStringSchema,
});
const EvidenceConflictSchema = z.strictObject({
  code: NonEmptyStringSchema,
  material: z.boolean(),
  message: NonEmptyStringSchema,
});

export const EvidenceBundleSchema = z
  .strictObject({
    candidateDocumentTypes: z.array(DocumentTypeCandidateSchema),
    candidateEntities: z.array(EntityCandidateSchema),
    conflicts: z.array(EvidenceConflictSchema),
    matchedRules: z.array(MatchedRuleSchema),
    observedFacts: z.array(EvidenceFactSchema),
    sourceLocators: z.array(NonEmptyStringSchema),
    targetId: NonEmptyStringSchema,
  })
  .meta({ id: "EvidenceBundle" });
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export const DecisionScopeSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ id: NonEmptyStringSchema, type: z.literal("item") }),
    z.strictObject({ id: NonEmptyStringSchema, type: z.literal("folder") }),
    z.strictObject({ id: NonEmptyStringSchema, type: z.literal("deal") }),
    z.strictObject({
      id: NonEmptyStringSchema,
      type: z.literal("document-type"),
    }),
    z.strictObject({ id: z.null(), type: z.literal("global") }),
  ])
  .meta({ id: "DecisionScope" });
export type DecisionScope = z.infer<typeof DecisionScopeSchema>;

export const DecisionRecordSchema = z
  .strictObject({
    answer: z.json(),
    approver: NonEmptyStringSchema,
    createdTime: IsoDateTimeSchema,
    evidenceIds: z.array(NonEmptyStringSchema),
    policyVersion: NonEmptyStringSchema,
    questionKey: NonEmptyStringSchema,
    scope: DecisionScopeSchema,
    supersedesDecisionId: NonEmptyStringSchema.nullable(),
  })
  .meta({ id: "DecisionRecord" });
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const ProposedActionSchema = z
  .strictObject({
    actionId: NonEmptyStringSchema,
    confidence: z.number().min(0).max(1),
    desiredState: JsonObjectSchema,
    evidenceIds: z.array(NonEmptyStringSchema),
    policyVersion: NonEmptyStringSchema,
    preconditions: JsonObjectSchema,
    reasonCode: NonEmptyStringSchema,
    reviewState: ProposalReviewStateSchema,
    scanGeneration: NonEmptyStringSchema,
    targetId: NonEmptyStringSchema,
    type: ActionTypeSchema,
  })
  .meta({ id: "ProposedAction" });
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const ApprovedPlanSchema = z
  .strictObject({
    actions: z.array(ProposedActionSchema),
    approvalState: z.literal("Approved"),
    approvalTime: IsoDateTimeSchema,
    approver: NonEmptyStringSchema,
    expiresAt: IsoDateTimeSchema.nullable(),
    invalidationReason: z.null(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/u),
    policyVersion: NonEmptyStringSchema,
    scanGeneration: NonEmptyStringSchema,
  })
  .meta({ id: "ApprovedPlan" });
export type ApprovedPlan = z.infer<typeof ApprovedPlanSchema>;

export const OperationReceiptSchema = z
  .strictObject({
    actionId: NonEmptyStringSchema,
    afterState: JsonObjectSchema,
    attempt: z.number().int().positive(),
    beforeState: JsonObjectSchema,
    providerResponseSummary: JsonObjectSchema,
    requestSummary: JsonObjectSchema,
    runId: NonEmptyStringSchema,
    verificationResult: z.enum(["Pending", "Verified", "Mismatch"]),
  })
  .meta({ id: "OperationReceipt" });
export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;

const RunEventSchema = z.strictObject({
  actionId: NonEmptyStringSchema.nullable(),
  at: IsoDateTimeSchema,
  reason: NonEmptyStringSchema.nullable(),
  sequence: z.number().int().positive(),
  state: RunStateSchema,
});

export const RunLedgerSchema = z
  .strictObject({
    blockedReason: NonEmptyStringSchema.nullable(),
    events: z.array(RunEventSchema),
    metrics: z.record(z.string(), z.number()),
    resumeCursor: NonEmptyStringSchema.nullable(),
    runId: NonEmptyStringSchema,
    state: RunStateSchema,
  })
  .meta({ id: "RunLedger" });
export type RunLedger = z.infer<typeof RunLedgerSchema>;

const SimulatedNodeSchema = z.strictObject({
  contentFingerprint: NonEmptyStringSchema.nullable(),
  contentLocator: NonEmptyStringSchema.nullable(),
  id: NonEmptyStringSchema,
  mimeType: NonEmptyStringSchema,
  name: z.string(),
  parentIds: z.array(NonEmptyStringSchema),
  permission: z.enum(["readable", "denied", "protected"]),
  shortcutTargetId: NonEmptyStringSchema.nullable(),
});

export const SimulatedDriveManifestSchema = z
  .strictObject({
    clock: IsoDateTimeSchema,
    contentLocators: z.record(z.string(), NonEmptyStringSchema),
    injectedFaults: z.array(JsonObjectSchema),
    labId: NonEmptyStringSchema,
    nodes: z.array(SimulatedNodeSchema),
    pageBoundaries: z.array(z.array(NonEmptyStringSchema)),
    parentEdges: z.array(
      z.strictObject({
        childId: NonEmptyStringSchema,
        parentId: NonEmptyStringSchema,
      }),
    ),
    scenarioVersion: NonEmptyStringSchema,
    shortcuts: z.array(
      z.strictObject({
        id: NonEmptyStringSchema,
        parentId: NonEmptyStringSchema,
        targetId: NonEmptyStringSchema,
      }),
    ),
  })
  .meta({ id: "SimulatedDriveManifest" });
export type SimulatedDriveManifest = z.infer<
  typeof SimulatedDriveManifestSchema
>;

export const ReviewArtifactManifestSchema = z
  .strictObject({
    artifactVersion: NonEmptyStringSchema,
    dataMinimization: z.array(NonEmptyStringSchema),
    generatedTime: IsoDateTimeSchema,
    includedPanels: z.array(NonEmptyStringSchema),
    planHash: z.string().regex(/^[a-f0-9]{64}$/u),
    policyVersion: NonEmptyStringSchema,
    scanGeneration: NonEmptyStringSchema,
    sourceLedger: z.array(NonEmptyStringSchema),
  })
  .meta({ id: "ReviewArtifactManifest" });
export type ReviewArtifactManifest = z.infer<
  typeof ReviewArtifactManifestSchema
>;

const FeedbackQuestionAnswerSchema = z.strictObject({
  answer: z.json(),
  questionKey: NonEmptyStringSchema,
  scope: DecisionScopeSchema,
});
const ActionReviewSchema = z.strictObject({
  actionId: NonEmptyStringSchema,
  comment: z.string(),
  disposition: z.enum(["Accept", "Reject", "Edit", "Ask"]),
  proposedName: z.string().nullable(),
});
const ProposedEditSchema = z.strictObject({
  actionId: NonEmptyStringSchema,
  field: NonEmptyStringSchema,
  value: z.json(),
});
const ReviewCommentSchema = z.strictObject({
  actionId: NonEmptyStringSchema.nullable(),
  text: z.string(),
});

export const ReviewFeedbackPacketSchema = z
  .strictObject({
    actionReviews: z.array(ActionReviewSchema),
    artifactVersion: NonEmptyStringSchema,
    checksum: NonEmptyStringSchema,
    comments: z.array(ReviewCommentSchema),
    exportTime: IsoDateTimeSchema,
    packetVersion: NonEmptyStringSchema,
    planHash: z.string().regex(/^[a-f0-9]{64}$/u),
    policyVersion: NonEmptyStringSchema,
    proposedEdits: z.array(ProposedEditSchema),
    questionAnswers: z.array(FeedbackQuestionAnswerSchema),
    reviewRound: z.number().int().positive(),
    reviewer: NonEmptyStringSchema,
    scanGeneration: NonEmptyStringSchema,
  })
  .meta({ id: "ReviewFeedbackPacket" });
export type ReviewFeedbackPacket = z.infer<typeof ReviewFeedbackPacketSchema>;

export const coreSchemas = {
  ApprovedPlan: ApprovedPlanSchema,
  DecisionRecord: DecisionRecordSchema,
  EvidenceBundle: EvidenceBundleSchema,
  ObservedItem: ObservedItemSchema,
  OperationReceipt: OperationReceiptSchema,
  PolicyPack: PolicyPackSchema,
  ProposedAction: ProposedActionSchema,
  ReviewArtifactManifest: ReviewArtifactManifestSchema,
  ReviewFeedbackPacket: ReviewFeedbackPacketSchema,
  RunLedger: RunLedgerSchema,
  ScanCoverage: ScanCoverageSchema,
  SimulatedDriveManifest: SimulatedDriveManifestSchema,
} as const;
