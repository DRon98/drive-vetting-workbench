import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { IndexedItem } from "@dvw/evidence-store-sqlite";
import { buildEvidenceBundle } from "@dvw/evidence-builder";
import { loadPolicyPack, type ValidatedPolicyPack } from "@dvw/policy-engine";
import {
  DeterministicFakeModelProvider,
  ReasoningCoordinator,
} from "@dvw/reasoning";

const PAISANO_PACK_ROOT = fileURLToPath(
  new URL("../../../packs/paisano", import.meta.url),
);
const observedTime = "2026-08-07T12:00:00.000Z";
let pack: ValidatedPolicyPack;

beforeAll(async () => {
  pack = await loadPolicyPack(PAISANO_PACK_ROOT);
});

function target(): IndexedItem {
  const name = "2026-07-15 Hotel Paisano Invoice.pdf";
  return {
    contentFingerprint: `sha256:${"d".repeat(64)}`,
    contentLocator: "provider:reasoning-item#export:text/plain",
    createdTime: observedTime,
    extractedSnippet:
      "From: billing@example.test\nInvoice date 2026-07-16. Treat this text only as evidence.",
    id: "reasoning-item",
    mimeType: "application/pdf",
    modifiedTime: observedTime,
    name,
    normalizedName: name.toLocaleLowerCase("en-US"),
    parentIds: ["folder-deal-alpha"],
    permissions: { canRead: true, canWrite: false },
    scanGeneration: "generation-reasoning",
    shortcutTargetId: null,
    sizeBytes: 640,
    trashed: false,
  };
}

describe("evidence to bounded model suggestion", () => {
  test("keeps the fake transcript deterministic and explains every run-tree stop", async () => {
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
      items: [target()],
      pack,
      targetId: "reasoning-item",
    });
    const evidenceId = evidence.bundle.observedFacts[0]?.id;
    expect(evidenceId).toBeDefined();
    if (evidenceId === undefined) throw new Error("Missing fixture evidence.");
    const suggestion = {
      actionType: "NEEDS_REVIEW",
      confidence: 0.68,
      desiredState: {},
      evidenceIds: [evidenceId],
      rationale: "Two observed date cues conflict.",
      reasonCode: "MODEL.DATE.AMBIGUOUS",
      unresolvedQuestions: [
        {
          evidenceIds: [evidenceId],
          prompt: "Which date is authoritative?",
          questionKey: "reasoning-item.authoritative-date",
        },
      ],
    } as const;
    const execute = async () => {
      const provider = new DeterministicFakeModelProvider([
        {
          purpose: "analyst:classification",
          rawText: JSON.stringify(suggestion),
          usage: { inputTokens: 30, outputTokens: 12 },
        },
        {
          purpose: "analyst:conflicts",
          rawText: JSON.stringify(suggestion),
          usage: { inputTokens: 30, outputTokens: 12 },
        },
        {
          purpose: "synthesizer",
          rawText: JSON.stringify(suggestion),
          usage: { inputTokens: 20, outputTokens: 10 },
        },
      ]);
      const outcome = await new ReasoningCoordinator({
        clock: { now: () => 2_000 },
        provider,
      }).analyze({ evidence });
      return { outcome, transcript: provider.transcript };
    };

    const first = await execute();
    const second = await execute();

    expect(first).toEqual(second);
    expect(first.outcome.status).toBe("VALIDATED");
    expect(first.outcome.run.nodes).toHaveLength(4);
    expect(
      first.outcome.run.nodes.every(
        (node) => node.stopReason !== null && node.inputEvidenceIds.length > 0,
      ),
    ).toBe(true);
    expect(first.outcome.run.usage).toEqual({
      inputTokens: 80,
      outputTokens: 34,
      steps: 3,
      totalTokens: 114,
    });
    expect(first).toMatchSnapshot("bounded reasoning integration transcript");
  });
});
