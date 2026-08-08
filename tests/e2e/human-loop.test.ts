import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewFixture } from "../../apps/review-preview/src/fixture.js";
import { resetAdversarialFixtures } from "../../scripts/reset-fixtures.js";
import { buildChangePlan } from "@dvw/change-planner";
import type { ObservedItem } from "@dvw/core";
import { DriveLab } from "@dvw/drive-simulator";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import type { EvidenceBuildResult } from "@dvw/evidence-builder";
import {
  createReviewFeedbackPacket,
  feedbackContextFromReview,
  parseReviewFeedbackPacket,
  replanFromReviewFeedback,
  serializeReviewFeedbackPacket,
} from "@dvw/feedback";
import {
  applyApprovedPlan,
  createApprovalArtifact,
  dryRunApprovedPlan,
  ExecutionLedger,
  verifyRecordedRun,
} from "@dvw/execution";
import {
  writeReviewArtifactCreateOnly,
  type ReviewArtifactInput,
} from "@dvw/review-artifact";
import { scanFolder } from "@dvw/scanner";
import { afterEach, describe, expect, test, vi } from "vitest";

const checkedAt = "2026-08-08T17:30:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

function observedItems(lab: DriveLab, scanGeneration: string): ObservedItem[] {
  return lab.manifest.nodes.map((node) => ({
    contentFingerprint: node.contentFingerprint,
    createdTime: node.createdTime,
    id: node.id,
    mimeType: node.mimeType,
    modifiedTime: node.modifiedTime,
    name: node.name,
    parentIds: node.parentIds,
    permissions: node.permissions,
    scanGeneration,
    shortcutTargetId: node.shortcutTargetId,
    trashed: false,
  }));
}

function editedEvidence(
  target: ObservedItem,
  evidenceId: string,
  policyVersion: string,
  scanGeneration: string,
): EvidenceBuildResult {
  return {
    bundle: {
      candidateDocumentTypes: [{ confidence: 0.98, documentTypeId: "invoice" }],
      candidateEntities: [{ confidence: 0.98, entityId: "hotel-paisano" }],
      conflicts: [],
      matchedRules: [
        {
          policyLocator: "paisano:1.0.0/naming.json#invoice",
          reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
        },
      ],
      observedFacts: [
        {
          field: "item.name",
          id: evidenceId,
          source: "Observed",
          sourceLocator: `drive:item:${target.id}#name`,
          value: target.name,
        },
      ],
      sourceLocators: [
        `drive:item:${target.id}#name`,
        "paisano:1.0.0/naming.json#invoice",
      ],
      targetId: target.id,
    },
    context: {
      archive: {
        actionType: "KEEP",
        identityComponents: [],
        isArchive: false,
        isConfigured: false,
        isFrozen: false,
        itemId: target.id,
        matchedRules: [],
        preserveHierarchy: false,
        reasonCode: "PAISANO.ARCHIVE.NOT_AN_ARCHIVE",
      },
      protected: {
        actionType: "KEEP",
        flags: [],
        itemId: target.id,
        matchedRules: [],
        reasonCode: "PAISANO.PROTECTED.NO_RULE_MATCH",
      },
    },
    duplicateCandidates: [],
    namingParts: [],
    policyVersion,
    reviewState: "DETERMINISTIC",
    scanGeneration,
  };
}

function executionLedger(root: string): ExecutionLedger {
  const path = join(root, "execution.sqlite");
  const store = new EvidenceStore(path);
  store.migrate();
  store.close();
  return new ExecutionLedger(path);
}

describe("T21 human-operated Drive Lab review loop", () => {
  test("round-trips feedback losslessly and applies only the separately approved final plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-human-loop-"));
    const labsRoot = join(root, "labs");
    resetAdversarialFixtures(labsRoot);
    const labRoot = join(labsRoot, "messy-paisano");
    const lab = DriveLab.open(labRoot);
    lab.applyEdit({
      content: "Synthetic operator-edited invoice dated 2026-08-01.",
      exportMimeType: "text/plain",
      itemId: "messy-invoice-draft",
      type: "content",
    });
    const reviewSnapshot = lab.snapshot();

    const evidenceStore = new EvidenceStore(join(root, "evidence.sqlite"));
    evidenceStore.migrate();
    const scan = await scanFolder({
      extractContent: false,
      generationId: "scan-human-loop-1",
      maxShortcutDepth: 8,
      pageSize: 2,
      provider: lab.read,
      rootId: lab.manifest.rootId,
      startedAt: "2026-08-08T16:00:00.000Z",
      store: evidenceStore,
    });
    expect(scan).toMatchObject({
      itemCount: 4,
      pageCount: 2,
      published: true,
    });
    expect(
      evidenceStore.getActiveItemById("messy-invoice-draft")
        ?.contentFingerprint,
    ).toBe(
      lab.manifest.nodes.find((node) => node.id === "messy-invoice-draft")
        ?.contentFingerprint,
    );
    evidenceStore.close();

    const firstReview = buildReviewFixture({
      artifactRoot: join(root, "review-round-1"),
      labRoot,
    });
    expect(firstReview.input.coverage.complete).toBe(true);
    expect(firstReview.input.plan.approvalEligible).toBe(true);
    expect(firstReview.artifactPath).toMatch(/\.html$/u);

    const sourceAction = firstReview.input.plan.actions[0];
    const sourceQuestion = firstReview.input.questions[0];
    const answer = sourceQuestion?.choices[0];
    if (
      sourceAction === undefined ||
      sourceQuestion === undefined ||
      answer === undefined
    ) {
      throw new Error("Synthetic review action or question is missing.");
    }
    const finalName =
      "2026-08-01 - Hotel Paisano - Final Synthetic Invoice.pdf";
    const packet = createReviewFeedbackPacket(
      feedbackContextFromReview(firstReview.input),
      {
        actions: [
          {
            actionId: sourceAction.actionId,
            comment: "Use the final synthetic invoice label.",
            disposition: "Edit",
            proposedName: finalName,
            reason: {
              code: "REVIEWER_EDIT",
              detail: "The operator confirmed the final synthetic label.",
            },
          },
        ],
        globalComment: "Replan locally, then request separate approval.",
        questions: [
          {
            answer,
            comment: "Use the synthetic invoice body date.",
            questionKey: sourceQuestion.questionKey,
            scope: sourceQuestion.scope,
          },
        ],
      },
      {
        exportedAt: "2026-08-08T16:30:00.000Z",
        reviewer: "Synthetic fixture operator",
      },
    );
    const serialized = serializeReviewFeedbackPacket(packet);
    const imported = parseReviewFeedbackPacket(
      `\`\`\`json\n${serialized.trimEnd()}\n\`\`\``,
      feedbackContextFromReview(firstReview.input),
    );
    expect(serializeReviewFeedbackPacket(imported)).toBe(serialized);

    const feedbackReplan = replanFromReviewFeedback(
      firstReview.input,
      imported,
    );
    expect(feedbackReplan).toMatchObject({
      approvalGranted: false,
      reviewRound: 2,
      sourcePlanHash: firstReview.input.plan.planHash,
    });
    expect(feedbackReplan.plan.approvalEligible).toBe(false);
    expect(feedbackReplan.preview.rejectedFields).toEqual([]);
    expect(feedbackReplan.decisionCandidates).toHaveLength(1);

    const scanGeneration = firstReview.input.plan.scanGeneration;
    const currentItems = observedItems(lab, scanGeneration);
    const target = currentItems.find(
      (item) => item.id === "messy-invoice-draft",
    );
    const evidenceId = sourceAction.evidenceIds[0];
    if (target === undefined || evidenceId === undefined) {
      throw new Error("Synthetic final-plan evidence is missing.");
    }
    const finalPlan = buildChangePlan({
      candidates: [
        {
          evidence: editedEvidence(
            target,
            evidenceId,
            firstReview.input.plan.policyVersion,
            scanGeneration,
          ),
          questions: [],
          reasoning: {
            status: "VALIDATED",
            suggestion: {
              actionType: "RENAME",
              confidence: 0.97,
              desiredState: { name: finalName },
              evidenceIds: [evidenceId],
              rationale:
                "The normal planner validated the operator's synthetic edit.",
              reasonCode: "HUMAN_FEEDBACK.REVIEWER_EDIT",
              unresolvedQuestions: [],
            },
          },
        },
      ],
      observedItems: currentItems,
      policyVersion: firstReview.input.plan.policyVersion,
      scanGeneration,
    });
    expect(finalPlan.approvalEligible).toBe(true);
    expect(finalPlan.planHash).toBe(feedbackReplan.plan.planHash);

    const secondReview: ReviewArtifactInput = {
      ...firstReview.input,
      feedbackSummary: {
        importedChecksum: imported.checksum,
        nextPlanHash: finalPlan.planHash,
        nextReviewRound: feedbackReplan.reviewRound,
        sourcePlanHash: firstReview.input.plan.planHash,
        sourceReviewRound: firstReview.input.reviewRound,
      },
      generatedAt: "2026-08-08T16:40:00.000Z",
      importedFeedback: imported,
      nextHumanAction: "Approve the final plan through the separate CLI gate.",
      plan: finalPlan,
      questions: [],
      reviewRound: feedbackReplan.reviewRound,
      title: "Synthetic round-two Drive review",
    };
    const network = vi.fn(() =>
      Promise.reject(new Error("The offline loop attempted a network call.")),
    );
    vi.stubGlobal("fetch", network);
    const roundTwoPath = join(
      root,
      "review-round-2",
      `review-${finalPlan.planHash}.html`,
    );
    const regenerated = writeReviewArtifactCreateOnly(
      roundTwoPath,
      secondReview,
    );
    expect(regenerated.html).toContain(imported.checksum);
    expect(regenerated.html).toContain(finalName);
    expect(regenerated.html).toContain("connect-src 'none'");
    expect(regenerated.html).not.toMatch(/(?:src|href)=["']https?:/iu);
    expect(network).not.toHaveBeenCalled();

    const approval = createApprovalArtifact(finalPlan, {
      approvedAt: "2026-08-08T17:00:00.000Z",
      approver: "Synthetic fixture operator",
      confirmation: `APPROVE ${finalPlan.planHash}`,
      expiresAt: "2026-08-08T18:00:00.000Z",
    });
    const dryRun = await dryRunApprovedPlan({
      approval,
      checkedAt,
      plan: finalPlan,
      provider: lab.read,
    });
    expect(dryRun).toMatchObject({ status: "Ready", writeCount: 0 });
    expect(lab.writeCount).toBe(0);

    const ledger = executionLedger(root);
    const applied = await applyApprovedPlan({
      approval,
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T17:31:00.000Z",
      plan: finalPlan,
      providerId: "drive-lab",
      readProvider: lab.read,
    });
    expect(applied).toMatchObject({
      mutationCallCount: 1,
      resumeCursor: 1,
      state: "Completed",
    });
    expect(
      applied.receipts.map((receipt) => receipt.verificationStatus),
    ).toEqual(["Verified"]);
    expect(lab.mutationRequests.map((request) => request.method)).toEqual([
      "rename",
    ]);
    expect(lab.tree()).toContain(finalName);
    expect(lab.diff(reviewSnapshot.hash)).toEqual([
      { itemId: "messy-invoice-draft", kind: "CHANGED" },
    ]);

    const verified = await verifyRecordedRun({
      ledger,
      plan: finalPlan,
      readProvider: lab.read,
      runId: applied.runId,
    });
    expect(verified).toMatchObject({
      failedActionCount: 0,
      state: "Completed",
      verifiedActionCount: 1,
    });

    const writesBeforeReapply = lab.writeCount;
    const reapplied = await applyApprovedPlan({
      approval,
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T17:32:00.000Z",
      plan: finalPlan,
      providerId: "drive-lab",
      readProvider: lab.read,
    });
    expect(reapplied).toMatchObject({
      mutationCallCount: 0,
      resumeCursor: 1,
      state: "Completed",
    });
    expect(lab.writeCount).toBe(writesBeforeReapply);
    expect(network).not.toHaveBeenCalled();
    ledger.close();
  });
});
