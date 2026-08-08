import { ChangePlanSchema } from "@dvw/change-planner";
import {
  ReviewFeedbackPacketSchema,
  hasValidFeedbackChecksum,
} from "@dvw/feedback";
import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);
const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const REVIEW_ARTIFACT_VERSION = "dvw.review.v1" as const;
export const REVIEW_TABS = [
  "overview",
  "drive-map",
  "changes",
  "questions",
  "feedback",
  "sources",
] as const;

const ReviewEvidenceSchema = z.strictObject({
  id: NonEmptyStringSchema,
  kind: z.enum([
    "Observed",
    "Policy",
    "HumanDecision",
    "ModelSuggestion",
    "Receipt",
  ]),
  label: NonEmptyStringSchema,
  sourceLocator: NonEmptyStringSchema,
  value: z.string(),
});

const ReviewPolicyMatchSchema = z.strictObject({
  reasonCode: NonEmptyStringSchema,
  sourceLocator: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
});

export const ReviewNodeSchema = z.strictObject({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  depth: z.number().int().min(0).max(16),
  evidence: z.array(ReviewEvidenceSchema),
  id: NonEmptyStringSchema,
  mimeType: NonEmptyStringSchema,
  name: z.string(),
  parentIds: z.array(NonEmptyStringSchema),
  policies: z.array(ReviewPolicyMatchSchema),
  protected: z.boolean(),
  shortcutTargetId: NonEmptyStringSchema.nullable(),
  sourceLocator: NonEmptyStringSchema,
});
export type ReviewNode = z.infer<typeof ReviewNodeSchema>;

const ReviewCoverageSchema = z.strictObject({
  complete: z.boolean(),
  deniedItemCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  pageCount: z.number().int().positive(),
  sourceLocator: NonEmptyStringSchema,
  warningCount: z.number().int().nonnegative(),
});

const DecisionScopeSchema = z.discriminatedUnion("type", [
  z.strictObject({ id: NonEmptyStringSchema, type: z.literal("item") }),
  z.strictObject({ id: NonEmptyStringSchema, type: z.literal("folder") }),
  z.strictObject({ id: NonEmptyStringSchema, type: z.literal("deal") }),
  z.strictObject({
    id: NonEmptyStringSchema,
    type: z.literal("document-type"),
  }),
  z.strictObject({ id: z.null(), type: z.literal("global") }),
]);

const ReviewQuestionSchema = z.strictObject({
  choices: z.array(z.json()).min(1),
  defaultChoice: z.json().nullable(),
  evidenceIds: z.array(NonEmptyStringSchema).min(1),
  policyLocators: z.array(NonEmptyStringSchema).min(1),
  prompt: NonEmptyStringSchema,
  questionKey: NonEmptyStringSchema,
  scope: DecisionScopeSchema,
});

const ReviewReceiptSchema = z.strictObject({
  runId: NonEmptyStringSchema,
  sourceLocator: NonEmptyStringSchema,
  status: z.enum(["Verified", "Blocked", "Partial", "Failed", "No-op"]),
  summary: NonEmptyStringSchema,
});

const ReviewSourceSchema = z.strictObject({
  claim: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  locator: NonEmptyStringSchema,
});

const ReviewGlossarySchema = z.strictObject({
  definition: NonEmptyStringSchema,
  sourceLocator: NonEmptyStringSchema,
  term: NonEmptyStringSchema,
});

const FeedbackSummarySchema = z.strictObject({
  importedChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
  nextPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
  nextReviewRound: z.number().int().positive(),
  sourcePlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceReviewRound: z.number().int().positive(),
});

export const ReviewArtifactInputSchema = z
  .strictObject({
    artifactVersion: z.literal(REVIEW_ARTIFACT_VERSION),
    coverage: ReviewCoverageSchema,
    generatedAt: IsoDateTimeSchema,
    feedbackSummary: FeedbackSummarySchema.optional(),
    glossary: z.array(ReviewGlossarySchema).min(1),
    importedFeedback: ReviewFeedbackPacketSchema.optional(),
    nextHumanAction: NonEmptyStringSchema,
    nodes: z.array(ReviewNodeSchema).min(1),
    plan: ChangePlanSchema,
    priorReceipts: z.array(ReviewReceiptSchema),
    questions: z.array(ReviewQuestionSchema),
    reviewRound: z.number().int().positive(),
    scope: z.strictObject({
      name: NonEmptyStringSchema,
      rootId: NonEmptyStringSchema,
    }),
    sourceSnapshot: NonEmptyStringSchema,
    sources: z.array(ReviewSourceSchema).min(1),
    title: NonEmptyStringSchema,
  })
  .superRefine((input, context) => {
    const nodeIds = input.nodes.map((node) => node.id);
    if (new Set(nodeIds).size !== nodeIds.length) {
      context.addIssue({
        code: "custom",
        message: "Review node IDs must be unique.",
        path: ["nodes"],
      });
    }
    const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
    const root = nodesById.get(input.scope.rootId);
    if (root === undefined || root.depth !== 0 || root.parentIds.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "Review scope root must be a depth-zero parentless node.",
        path: ["scope", "rootId"],
      });
    }
    for (const [index, node] of input.nodes.entries()) {
      for (const parentId of node.parentIds) {
        if (!nodesById.has(parentId)) {
          context.addIssue({
            code: "custom",
            message: `Review parent ${parentId} is missing.`,
            path: ["nodes", index, "parentIds"],
          });
        }
      }
    }
    for (const [index, action] of input.plan.actions.entries()) {
      if (!nodesById.has(action.targetId)) {
        context.addIssue({
          code: "custom",
          message: `Review target ${action.targetId} is missing from the tree.`,
          path: ["plan", "actions", index, "targetId"],
        });
      }
    }
    const questionKeys = input.questions.map(
      (question) => question.questionKey,
    );
    if (new Set(questionKeys).size !== questionKeys.length) {
      context.addIssue({
        code: "custom",
        message: "Review question keys must be unique.",
        path: ["questions"],
      });
    }
    if (
      (input.importedFeedback === undefined) !==
      (input.feedbackSummary === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Imported feedback and its replan summary must appear together.",
        path: ["importedFeedback"],
      });
    }
    if (
      input.importedFeedback !== undefined &&
      input.feedbackSummary !== undefined
    ) {
      if (!hasValidFeedbackChecksum(input.importedFeedback)) {
        context.addIssue({
          code: "custom",
          message:
            "Imported feedback checksum does not match its canonical payload.",
          path: ["importedFeedback", "checksum"],
        });
      }
      if (
        input.feedbackSummary.importedChecksum !==
          input.importedFeedback.checksum ||
        input.feedbackSummary.sourcePlanHash !==
          input.importedFeedback.planHash ||
        input.feedbackSummary.sourceReviewRound !==
          input.importedFeedback.reviewRound
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Feedback summary does not match the imported source packet.",
          path: ["feedbackSummary"],
        });
      }
      if (
        input.feedbackSummary.nextPlanHash !== input.plan.planHash ||
        input.feedbackSummary.nextReviewRound !== input.reviewRound ||
        input.plan.policyVersion !== input.importedFeedback.policyVersion ||
        input.plan.scanGeneration !== input.importedFeedback.scanGeneration
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Feedback summary does not match the regenerated review context.",
          path: ["feedbackSummary"],
        });
      }
    }
  });
export type ReviewArtifactInput = z.infer<typeof ReviewArtifactInputSchema>;

export const ReviewArtifactManifestSchema = z.strictObject({
  artifactVersion: z.literal(REVIEW_ARTIFACT_VERSION),
  generatedAt: IsoDateTimeSchema,
  includedPanels: z.tuple([
    z.literal("overview"),
    z.literal("drive-map"),
    z.literal("changes"),
    z.literal("questions"),
    z.literal("feedback"),
    z.literal("sources"),
  ]),
  minimizedFields: z.array(NonEmptyStringSchema),
  planHash: z.string().regex(/^[a-f0-9]{64}$/u),
  policyVersion: NonEmptyStringSchema,
  reviewRound: z.number().int().positive(),
  scanGeneration: NonEmptyStringSchema,
  sourceSnapshot: NonEmptyStringSchema,
});
export type ReviewArtifactManifest = z.infer<
  typeof ReviewArtifactManifestSchema
>;

export interface GeneratedReviewArtifact {
  readonly html: string;
  readonly htmlSha256: string;
  readonly manifest: ReviewArtifactManifest;
}
