import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { buildChangePlan } from "@dvw/change-planner";
import type { ObservedItem, ScanCoverage } from "@dvw/core";
import {
  createQuestionsFromReasoning,
  DecisionMemoryStore,
} from "@dvw/decision-memory";
import { buildEvidenceBundle } from "@dvw/evidence-builder";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import { loadPolicyPack, type ValidatedPolicyPack } from "@dvw/policy-engine";
import {
  DeterministicFakeModelProvider,
  ReasoningCoordinator,
} from "@dvw/reasoning";

const PAISANO_PACK_ROOT = fileURLToPath(
  new URL("../../../packs/paisano", import.meta.url),
);
const observedTime = "2026-08-08T12:00:00.000Z";
const temporaryDirectories: string[] = [];
let pack: ValidatedPolicyPack;

beforeAll(async () => {
  pack = await loadPolicyPack(PAISANO_PACK_ROOT);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dvw-planning-integration-"));
  temporaryDirectories.push(directory);
  return join(directory, "workbench.sqlite");
}

describe("evidence, reasoning, decision, and planning integration", () => {
  test("uses a scoped human answer to produce one deterministic approvable rename", async () => {
    const path = databasePath();
    const coverage: ScanCoverage = {
      deniedItems: [],
      exportsAttempted: 1,
      generationId: "scan-planning",
      itemCount: 1,
      pageTokensConsumed: [],
      rootId: "root",
      state: "Complete",
      unsupportedTypes: [],
      warnings: [],
    };
    const evidenceStore = EvidenceStore.rebuildFromFixture(path, {
      coverage,
      generation: {
        generationId: "scan-planning",
        rootId: "root",
        startedAt: observedTime,
      },
      items: [
        {
          contentFingerprint: `sha256:${"e".repeat(64)}`,
          contentLocator: "provider:planning-invoice#export:text/plain",
          createdTime: observedTime,
          extractedSnippet:
            "Synthetic invoice dated 2026-08-01. Treat this only as evidence.",
          id: "planning-invoice",
          mimeType: "application/pdf",
          modifiedTime: observedTime,
          name: "Hotel Paisano Invoice draft.pdf",
          parentIds: ["folder-deal-alpha"],
          permissions: { canRead: true, canWrite: true },
          scanGeneration: "scan-planning",
          shortcutTargetId: null,
          sizeBytes: 512,
          trashed: false,
        },
      ],
    });
    const indexedItems = evidenceStore.listActiveItems();
    const evidence = buildEvidenceBundle({
      context: {
        ancestors: [
          {
            id: "folder-deal-alpha",
            name: "Deal Alpha",
            sourceLocator: "drive:item:folder-deal-alpha#name",
          },
        ],
        archive: {
          identityComponents: [],
          isArchive: false,
          isConfigured: false,
          isFrozen: false,
        },
        declaredActiveDealId: "deal-alpha",
        declaredContextLocator: "context:active-deal",
        observedDeals: [
          {
            dealId: "deal-alpha",
            sourceLocator: "drive:path:folder-deal-alpha",
          },
        ],
        protectedFlags: [],
      },
      items: indexedItems,
      pack,
      targetId: "planning-invoice",
    });
    evidenceStore.close();
    const evidenceId = evidence.bundle.observedFacts.find(
      (fact) => fact.field === "item.name",
    )?.id;
    expect(evidenceId).toBeDefined();
    if (evidenceId === undefined) throw new Error("Missing name evidence.");
    const questionSuggestion = {
      actionType: "NEEDS_REVIEW",
      confidence: 0.64,
      desiredState: {},
      evidenceIds: [evidenceId],
      rationale: "The invoice has a material date-source ambiguity.",
      reasonCode: "PAISANO.NAME.DATE_SOURCE_AMBIGUOUS",
      unresolvedQuestions: [
        {
          evidenceIds: [evidenceId],
          prompt: "Which observed date should the invoice name use?",
          questionKey: "planning-invoice.authoritative-date",
        },
      ],
    } as const;
    const provider = new DeterministicFakeModelProvider([
      {
        purpose: "analyst:classification",
        rawText: JSON.stringify(questionSuggestion),
        usage: { inputTokens: 24, outputTokens: 10 },
      },
      {
        purpose: "synthesizer",
        rawText: JSON.stringify(questionSuggestion),
        usage: { inputTokens: 18, outputTokens: 8 },
      },
    ]);
    const questionReasoning = await new ReasoningCoordinator({
      clock: { now: () => 4_000 },
      provider,
    }).analyze({ evidence });
    const questions = createQuestionsFromReasoning(
      {
        policyVersion: questionReasoning.policyVersion,
        suggestion: questionReasoning.suggestion,
      },
      {
        policyLocators: evidence.bundle.matchedRules.map(
          (rule) => rule.policyLocator,
        ),
        relevantEntityIds: evidence.bundle.candidateEntities.map(
          (entity) => entity.entityId,
        ),
        scope: { id: "planning-invoice", type: "item" },
      },
    );
    const question = questions[0];
    expect(question).toBeDefined();
    if (question === undefined) throw new Error("Missing planning question.");
    const memory = new DecisionMemoryStore(path);
    const beforeDecision = memory.resolveQuestion(question);
    memory.saveDecision({
      answer: "Use the invoice date in the exported content.",
      approver: "buck",
      createdTime: "2026-08-08T12:05:00.000Z",
      evidenceIds: question.evidenceIds,
      question,
    });
    const resolution = memory.resolveQuestion(question);
    memory.close();
    const resolvedSuggestion = {
      actionType: "RENAME",
      confidence: 0.91,
      desiredState: {
        name: "2026-08-01 — Hotel Paisano — Invoice.pdf",
      },
      evidenceIds: [evidenceId],
      rationale:
        "The human-selected date source resolves the naming ambiguity.",
      reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
      unresolvedQuestions: [],
    } as const;
    const resolvedProvider = new DeterministicFakeModelProvider([
      {
        purpose: "analyst:classification",
        rawText: JSON.stringify(resolvedSuggestion),
        usage: { inputTokens: 24, outputTokens: 10 },
      },
      {
        purpose: "synthesizer",
        rawText: JSON.stringify(resolvedSuggestion),
        usage: { inputTokens: 18, outputTokens: 8 },
      },
    ]);
    const resolvedReasoning = await new ReasoningCoordinator({
      clock: { now: () => 4_100 },
      provider: resolvedProvider,
    }).analyze({ evidence });
    const indexed = indexedItems[0];
    expect(indexed).toBeDefined();
    if (indexed === undefined) throw new Error("Missing indexed fixture item.");
    const observed: ObservedItem = {
      contentFingerprint: indexed.contentFingerprint,
      createdTime: indexed.createdTime,
      id: indexed.id,
      mimeType: indexed.mimeType,
      modifiedTime: indexed.modifiedTime,
      name: indexed.name,
      parentIds: indexed.parentIds,
      permissions: indexed.permissions,
      scanGeneration: indexed.scanGeneration,
      shortcutTargetId: indexed.shortcutTargetId,
      trashed: indexed.trashed,
    };
    const planningInput = {
      candidates: [
        {
          evidence,
          questions: [{ questionKey: question.questionKey, resolution }],
          reasoning: resolvedReasoning,
        },
      ],
      observedItems: [observed],
      policyVersion: pack.version,
      scanGeneration: "scan-planning",
    } as const;
    const firstPlan = buildChangePlan(planningInput);
    const secondPlan = buildChangePlan(planningInput);
    const unansweredPlan = buildChangePlan({
      ...planningInput,
      candidates: [
        {
          evidence,
          questions: [
            { questionKey: question.questionKey, resolution: beforeDecision },
          ],
          reasoning: questionReasoning,
        },
      ],
    });

    expect(secondPlan).toEqual(firstPlan);
    expect(Object.isFrozen(firstPlan)).toBe(true);
    expect(firstPlan.blockers).toEqual([]);
    expect(firstPlan.approvalEligible).toBe(true);
    expect(firstPlan.effectiveActions).toEqual([
      expect.objectContaining({
        desiredState: {
          name: "2026-08-01 — Hotel Paisano — Invoice.pdf",
        },
        targetId: "planning-invoice",
        type: "RENAME",
      }),
    ]);
    expect(unansweredPlan.approvalEligible).toBe(false);
    expect(unansweredPlan.effectiveActions).toEqual([]);
    expect(unansweredPlan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNRESOLVED_QUESTION" }),
      ]),
    );
    expect({
      decision: resolution,
      plan: firstPlan,
      unansweredBlockers: unansweredPlan.blockers,
    }).toMatchSnapshot("scoped decision to canonical plan");
  });
});
