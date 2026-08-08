import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildChangePlan } from "@dvw/change-planner";
import type { ObservedItem } from "@dvw/core";
import { DriveLab } from "@dvw/drive-simulator";
import type { EvidenceBuildResult } from "@dvw/evidence-builder";
import {
  generateReviewArtifact,
  ReviewArtifactInputSchema,
  writeReviewArtifactCreateOnly,
  type ReviewArtifactInput,
} from "@dvw/review-artifact";

const SCAN_GENERATION = "scan-review-fixture-1";
const POLICY_VERSION = "1.0.0";
const GENERATED_AT = "2026-08-08T14:30:00.000Z";
const INVOICE_ID = "messy-invoice-draft";

export interface ReviewFixturePaths {
  readonly artifactRoot: string;
  readonly labRoot: string;
}

export interface BuiltReviewFixture {
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly input: ReviewArtifactInput;
  readonly scenario: "messy-paisano";
  readonly snapshotHash: string;
}

function observedItem(
  node: DriveLab["manifest"]["nodes"][number],
): ObservedItem {
  return {
    contentFingerprint: node.contentFingerprint,
    createdTime: node.createdTime,
    id: node.id,
    mimeType: node.mimeType,
    modifiedTime: node.modifiedTime,
    name: node.name,
    parentIds: node.parentIds,
    permissions: node.permissions,
    scanGeneration: SCAN_GENERATION,
    shortcutTargetId: node.shortcutTargetId,
    trashed: false,
  };
}

function invoiceEvidence(target: ObservedItem): EvidenceBuildResult {
  const evidenceId = `fact-${target.id}-name`;
  return {
    bundle: {
      candidateDocumentTypes: [{ confidence: 0.96, documentTypeId: "invoice" }],
      candidateEntities: [{ confidence: 0.97, entityId: "hotel-paisano" }],
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
    policyVersion: POLICY_VERSION,
    reviewState: "DETERMINISTIC",
    scanGeneration: SCAN_GENERATION,
  };
}

function openOrInitializeLab(labRoot: string): DriveLab {
  const lab = existsSync(labRoot)
    ? DriveLab.open(labRoot)
    : DriveLab.initialize(labRoot, "messy-paisano");
  if (lab.manifest.scenario !== "messy-paisano") {
    throw new Error(
      "Review fixture root contains a different Drive Lab scenario.",
    );
  }
  return lab;
}

function makeInput(lab: DriveLab): ReviewArtifactInput {
  const snapshot = lab.snapshot();
  const manifest = snapshot.manifest;
  const observed = manifest.nodes.map((node) => observedItem(node));
  const invoice = observed.find((item) => item.id === INVOICE_ID);
  if (invoice === undefined)
    throw new Error("Messy Paisano invoice is missing.");
  const evidence = invoiceEvidence(invoice);
  const evidenceId = evidence.bundle.observedFacts[0]?.id;
  if (evidenceId === undefined) throw new Error("Invoice evidence is missing.");
  const plan = buildChangePlan({
    candidates: [
      {
        evidence,
        questions: [],
        reasoning: {
          status: "VALIDATED",
          suggestion: {
            actionType: "RENAME",
            confidence: 0.93,
            desiredState: {
              name: "2026-08-01 - Hotel Paisano - Invoice.pdf",
            },
            evidenceIds: [evidenceId],
            rationale: "The synthetic invoice matches the Paisano naming rule.",
            reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
            unresolvedQuestions: [],
          },
        },
      },
    ],
    observedItems: observed,
    policyVersion: POLICY_VERSION,
    scanGeneration: SCAN_GENERATION,
  });
  const depths = new Map(
    lab.treeEntries().map((entry) => [entry.id, entry.depth]),
  );
  const reviewNodes = manifest.nodes.map((node) => {
    const invoiceNode = node.id === INVOICE_ID;
    return {
      canRead: node.permissions.canRead && !node.readDenied,
      canWrite: node.permissions.canWrite,
      depth: depths.get(node.id) ?? 0,
      evidence: [
        {
          id: invoiceNode ? evidenceId : `fact-${node.id}-name`,
          kind: "Observed" as const,
          label: "Observed Drive name",
          sourceLocator: `drive:item:${node.id}#name`,
          value: node.name,
        },
      ],
      id: node.id,
      mimeType: node.mimeType,
      name: node.name,
      parentIds: node.parentIds,
      policies: invoiceNode
        ? [
            {
              reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
              sourceLocator: "paisano:1.0.0/naming.json#invoice",
              summary: "Use the dated deal-document name for the invoice.",
            },
          ]
        : [],
      protected: !node.permissions.canWrite,
      shortcutTargetId: node.shortcutTargetId,
      sourceLocator: `drive:item:${node.id}`,
    };
  });
  const finalBoundary = manifest.pageBoundaries.at(-1) ?? 0;
  const pageCount =
    manifest.pageBoundaries.length +
    (finalBoundary < manifest.nodes.length ? 1 : 0);
  return ReviewArtifactInputSchema.parse({
    artifactVersion: "dvw.review.v1",
    coverage: {
      complete: true,
      deniedItemCount: 0,
      itemCount: manifest.nodes.length,
      pageCount,
      sourceLocator: `lab:${manifest.labId}:snapshot:${snapshot.hash}#coverage`,
      warningCount: 0,
    },
    generatedAt: GENERATED_AT,
    glossary: [
      {
        definition: "The immutable digest that identifies one exact plan.",
        sourceLocator: "contract:ChangePlan#planHash",
        term: "plan hash",
      },
      {
        definition: "A Drive reference that leaves the source item in place.",
        sourceLocator: "policy:paisano#shortcuts",
        term: "shortcut",
      },
    ],
    nextHumanAction:
      "Review the invoice rename and answer the date-source question.",
    nodes: reviewNodes,
    plan,
    priorReceipts: [
      {
        runId: "run-lab-shared-provider-1",
        sourceLocator: "fixture:t13#verified-shared-provider-receipt",
        status: "Verified",
        summary:
          "A synthetic rename and shortcut were re-fetched and verified.",
      },
    ],
    questions: [
      {
        choices: ["Invoice body date", "Observed modified date"],
        defaultChoice: "Invoice body date",
        evidenceIds: [evidenceId],
        policyLocators: ["paisano:1.0.0/naming.json#invoice"],
        prompt: "Which source should set the invoice date?",
        questionKey: "question-messy-invoice-date-source",
        scope: { id: INVOICE_ID, type: "item" },
      },
    ],
    reviewRound: 1,
    scope: {
      name: "Messy Paisano synthetic review",
      rootId: manifest.rootId,
    },
    sourceSnapshot: `Drive Lab messy-paisano snapshot ${snapshot.hash}`,
    sources: [
      {
        claim: `The complete synthetic snapshot contains ${manifest.nodes.length} visible items.`,
        label: "Drive Lab snapshot",
        locator: `lab:${manifest.labId}:snapshot:${snapshot.hash}`,
      },
      {
        claim: "The plan contains one typed, policy-backed rename proposal.",
        label: "Change plan",
        locator: `plan:${plan.planHash}`,
      },
      {
        claim: "The rename uses the Paisano deal-document naming rule.",
        label: "Paisano policy pack",
        locator: "paisano:1.0.0/naming.json#invoice",
      },
    ],
    title: "Drive review: Messy Paisano",
  });
}

export function buildReviewFixture(
  paths: ReviewFixturePaths,
): BuiltReviewFixture {
  const lab = openOrInitializeLab(paths.labRoot);
  const input = makeInput(lab);
  const generated = generateReviewArtifact(input);
  const artifactPath = join(
    paths.artifactRoot,
    `review-${input.plan.planHash}-round-${input.reviewRound}-${generated.htmlSha256}.html`,
  );
  const artifact = writeReviewArtifactCreateOnly(artifactPath, input);
  return Object.freeze({
    artifactPath,
    artifactSha256: artifact.htmlSha256,
    input,
    scenario: "messy-paisano" as const,
    snapshotHash: lab.snapshot().hash,
  });
}
