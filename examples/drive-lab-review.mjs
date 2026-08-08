import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { buildReviewFixture } from "../apps/review-preview/dist/fixture.js";
import { buildChangePlan } from "../packages/change-planner/dist/index.js";
import { DriveLab } from "../packages/drive-simulator/dist/index.js";
import { EvidenceStore } from "../packages/evidence-store-sqlite/dist/index.js";
import {
  createReviewFeedbackPacket,
  feedbackContextFromReview,
  parseReviewFeedbackPacket,
  replanFromReviewFeedback,
  serializeReviewFeedbackPacket,
} from "../packages/feedback/dist/index.js";
import {
  applyApprovedPlan,
  createApprovalArtifact,
  dryRunApprovedPlan,
  ExecutionLedger,
  verifyRecordedRun,
} from "../packages/execution/dist/index.js";
import { writeReviewArtifactCreateOnly } from "../packages/review-artifact/dist/index.js";
import { scanFolder } from "../packages/scanner/dist/index.js";

const checkedAt = "2026-08-08T17:30:00.000Z";
const scriptRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function requireValue(value, message) {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

function outputRoot() {
  const optionIndex = process.argv.indexOf("--output");
  if (optionIndex >= 0) {
    const requested = process.argv[optionIndex + 1];
    if (requested === undefined || requested.startsWith("--")) {
      throw new Error("--output needs one new directory path.");
    }
    const root = resolve(requested);
    if (existsSync(root)) {
      throw new Error("The quick-start output path already exists.");
    }
    mkdirSync(root, { recursive: true });
    return root;
  }
  const parent = resolve(scriptRoot, "artifacts", "local", "quickstart");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "run-"));
}

function observedItems(lab, scanGeneration) {
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

function editedEvidence(target, evidenceId, policyVersion, scanGeneration) {
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

function createExecutionLedger(root) {
  const path = join(root, "execution.sqlite");
  const store = new EvidenceStore(path);
  store.migrate();
  store.close();
  return new ExecutionLedger(path);
}

const root = outputRoot();
const labRoot = join(root, "drive-lab");
const lab = DriveLab.initialize(labRoot, "messy-paisano");
lab.applyEdit({
  content: "Synthetic operator-edited invoice dated 2026-08-01.",
  exportMimeType: "text/plain",
  itemId: "messy-invoice-draft",
  type: "content",
});
const editedSnapshot = lab.snapshot();

const evidenceStore = new EvidenceStore(join(root, "evidence.sqlite"));
evidenceStore.migrate();
const scan = await scanFolder({
  extractContent: false,
  generationId: "scan-public-quickstart-1",
  maxShortcutDepth: 8,
  pageSize: 2,
  provider: lab.read,
  rootId: lab.manifest.rootId,
  startedAt: "2026-08-08T16:00:00.000Z",
  store: evidenceStore,
});
if (!scan.published || scan.itemCount !== 4 || scan.pageCount !== 2) {
  throw new Error("The synthetic scan did not publish all expected pages.");
}
evidenceStore.close();

const roundOne = buildReviewFixture({
  artifactRoot: join(root, "review-round-1"),
  labRoot,
});
const sourceAction = requireValue(
  roundOne.input.plan.actions[0],
  "The synthetic review action is missing.",
);
const sourceQuestion = requireValue(
  roundOne.input.questions[0],
  "The synthetic review question is missing.",
);
const answer = requireValue(
  sourceQuestion.choices[0],
  "The synthetic review answer is missing.",
);
const finalName = "2026-08-01 - Hotel Paisano - Final Synthetic Invoice.pdf";
const feedback = createReviewFeedbackPacket(
  feedbackContextFromReview(roundOne.input),
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
const feedbackBytes = serializeReviewFeedbackPacket(feedback);
const feedbackPath = join(root, "review-feedback-v1.json");
writeFileSync(feedbackPath, feedbackBytes, { encoding: "utf8", flag: "wx" });
const imported = parseReviewFeedbackPacket(
  `\`\`\`json\n${feedbackBytes.trimEnd()}\n\`\`\``,
  feedbackContextFromReview(roundOne.input),
);
if (serializeReviewFeedbackPacket(imported) !== feedbackBytes) {
  throw new Error("The feedback packet did not survive a lossless round trip.");
}
const requestedReplan = replanFromReviewFeedback(roundOne.input, imported);
if (requestedReplan.approvalGranted || requestedReplan.plan.approvalEligible) {
  throw new Error("Feedback incorrectly granted approval.");
}

const scanGeneration = roundOne.input.plan.scanGeneration;
const currentItems = observedItems(lab, scanGeneration);
const target = requireValue(
  currentItems.find((item) => item.id === "messy-invoice-draft"),
  "The synthetic target is missing.",
);
const evidenceId = requireValue(
  sourceAction.evidenceIds[0],
  "The synthetic action evidence is missing.",
);
const finalPlan = buildChangePlan({
  candidates: [
    {
      evidence: editedEvidence(
        target,
        evidenceId,
        roundOne.input.plan.policyVersion,
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
          rationale: "The planner validated the synthetic operator edit.",
          reasonCode: "HUMAN_FEEDBACK.REVIEWER_EDIT",
          unresolvedQuestions: [],
        },
      },
    },
  ],
  observedItems: currentItems,
  policyVersion: roundOne.input.plan.policyVersion,
  scanGeneration,
});
if (
  !finalPlan.approvalEligible ||
  finalPlan.planHash !== requestedReplan.plan.planHash
) {
  throw new Error(
    "The final plan does not match the reviewed feedback replan.",
  );
}

let networkCallCount = 0;
const previousFetch = globalThis.fetch;
globalThis.fetch = () => {
  networkCallCount += 1;
  return Promise.reject(
    new Error("The offline quick start attempted a network call."),
  );
};
const roundTwoPath = join(
  root,
  "review-round-2",
  `review-${finalPlan.planHash}.html`,
);
const regenerated = writeReviewArtifactCreateOnly(roundTwoPath, {
  ...roundOne.input,
  feedbackSummary: {
    importedChecksum: imported.checksum,
    nextPlanHash: finalPlan.planHash,
    nextReviewRound: requestedReplan.reviewRound,
    sourcePlanHash: roundOne.input.plan.planHash,
    sourceReviewRound: roundOne.input.reviewRound,
  },
  generatedAt: "2026-08-08T16:40:00.000Z",
  importedFeedback: imported,
  nextHumanAction: "Approve the final plan through a separate operator gate.",
  plan: finalPlan,
  questions: [],
  reviewRound: requestedReplan.reviewRound,
  title: "Synthetic round-two Drive review",
});
globalThis.fetch = previousFetch;
if (
  !regenerated.html.includes("connect-src 'none'") ||
  !regenerated.html.includes(imported.checksum) ||
  networkCallCount !== 0
) {
  throw new Error("The regenerated review artifact is not self-contained.");
}

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
if (
  dryRun.status !== "Ready" ||
  dryRun.writeCount !== 0 ||
  lab.writeCount !== 0
) {
  throw new Error("The dry-run attempted a provider write.");
}

const ledger = createExecutionLedger(root);
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
const verified = await verifyRecordedRun({
  ledger,
  plan: finalPlan,
  readProvider: lab.read,
  runId: applied.runId,
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
ledger.close();
if (
  applied.state !== "Completed" ||
  applied.mutationCallCount !== 1 ||
  verified.state !== "Completed" ||
  verified.failedActionCount !== 0 ||
  reapplied.mutationCallCount !== 0 ||
  lab.writeCount !== writesBeforeReapply
) {
  throw new Error("The verified apply or idempotent replay contract failed.");
}
const finalTreePath = join(root, "verified-tree.txt");
writeFileSync(finalTreePath, `${lab.tree()}\n`, {
  encoding: "utf8",
  flag: "wx",
});

const result = {
  appliedMutationCount: applied.mutationCallCount,
  dryRunWriteCount: dryRun.writeCount,
  feedbackApprovalGranted: requestedReplan.approvalGranted,
  feedbackPath,
  feedbackRoundTrip: true,
  finalName,
  finalTreePath,
  idempotentReplayMutationCount: reapplied.mutationCallCount,
  networkCallCount,
  outputRoot: root,
  planHash: finalPlan.planHash,
  reviewArtifactPath: regenerated.path,
  scanItemCount: scan.itemCount,
  scanPageCount: scan.pageCount,
  state: verified.state,
  treeChangedFromEditedSnapshot: lab.diff(editedSnapshot.hash).length === 1,
  verifiedActionCount: verified.verifiedActionCount,
};
process.stdout.write(`QUICKSTART_RESULT ${JSON.stringify(result)}\n`);
