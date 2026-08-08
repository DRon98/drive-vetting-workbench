import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DriveLab } from "@dvw/drive-simulator";
import { EvidenceStore, type IndexedItem } from "@dvw/evidence-store-sqlite";
import { buildEvidenceBundle } from "@dvw/evidence-builder";
import {
  evaluateShortcut,
  listMaterialQuestions,
  loadPolicyPack,
  resolveEntityAlias,
} from "@dvw/policy-engine";
import {
  DeterministicFakeModelProvider,
  ReasoningCoordinator,
} from "@dvw/reasoning";
import { scanFolder } from "@dvw/scanner";
import { describe, expect, test } from "vitest";

const POLICY_ROOT = fileURLToPath(
  new URL("../../packs/paisano", import.meta.url),
);
const observedAt = "2026-08-08T12:00:00.000Z";
const scanGeneration = "scan-adversarial-1";

function indexedItem(
  id: string,
  contentFingerprint: string,
  sizeBytes: number,
): IndexedItem {
  return {
    contentFingerprint,
    contentLocator: `provider:${id}#export:text/plain`,
    createdTime: observedAt,
    extractedSnippet: `Synthetic evidence for ${id}.`,
    id,
    mimeType: "application/pdf",
    modifiedTime: observedAt,
    name: `${id} Hotel Paisano Invoice 2026-08-01.pdf`,
    normalizedName: `${id} hotel paisano invoice 2026-08-01.pdf`,
    parentIds: ["deal-alpha"],
    permissions: { canRead: true, canWrite: true },
    scanGeneration,
    shortcutTargetId: null,
    sizeBytes,
    trashed: false,
  };
}

async function scanScenario(
  scenario: "messy-paisano" | "pagination-gap" | "shortcut-cycle",
) {
  const root = mkdtempSync(join(tmpdir(), `dvw-${scenario}-`));
  const lab = DriveLab.initialize(join(root, "lab"), scenario);
  const store = new EvidenceStore(join(root, "evidence.sqlite"));
  store.migrate();
  const result = await scanFolder({
    extractContent: false,
    generationId: `scan-${scenario}`,
    maxShortcutDepth: 8,
    pageSize: 2,
    provider: lab.read,
    rootId: lab.manifest.rootId,
    startedAt: observedAt,
    store,
  });
  return { lab, result, store };
}

describe("T21 adversarial scan and policy matrix", () => {
  test("enumerates the messy tree and records stable parent and shortcut relations", async () => {
    const { result, store } = await scanScenario("messy-paisano");

    expect(result).toMatchObject({
      itemCount: 4,
      pageCount: 2,
      published: true,
    });
    expect(store.listActiveItems().map((item) => item.id)).toEqual([
      "messy-board-memo",
      "messy-communications",
      "messy-existing-shortcut",
      "messy-invoice-draft",
    ]);
    expect(
      store
        .traverseActiveRelations("messy-existing-shortcut", {
          direction: "outbound",
          maxDepth: 2,
        })
        .map((relation) => [
          relation.depth,
          relation.kind,
          relation.sourceItemId,
          relation.targetId,
        ]),
    ).toEqual([
      [1, "Parent", "messy-existing-shortcut", "messy-communications"],
      [1, "Shortcut", "messy-existing-shortcut", "messy-board-memo"],
      [2, "Parent", "messy-board-memo", "messy-root"],
      [2, "Parent", "messy-communications", "messy-root"],
    ]);
    store.close();
  });

  test("consumes the final API page and reports permission loss as a gap", async () => {
    const { result, store } = await scanScenario("pagination-gap");

    expect(result.itemCount).toBe(6);
    expect(result.pageCount).toBe(4);
    expect(store.getActiveItemById("pagination-item-6")).not.toBeNull();
    expect(result.coverage.deniedItems).toEqual([
      {
        itemId: "pagination-item-6",
        reason: "Synthetic final-page denial",
      },
    ]);
    expect(result.issues).toContainEqual({
      code: "DENIED_ITEM",
      detail: "Synthetic final-page denial",
      itemId: "pagination-item-6",
    });
    store.close();
  });

  test("reports a shortcut cycle without escaping the bounded scan", async () => {
    const { result, store } = await scanScenario("shortcut-cycle");

    expect(result.itemCount).toBe(2);
    expect(result.issues.some((issue) => issue.code === "SHORTCUT_CYCLE")).toBe(
      true,
    );
    expect(result.published).toBe(true);
    store.close();
  });

  test("distinguishes exact duplicates from equal-size different content and flags cross-deal context", async () => {
    const pack = await loadPolicyPack(POLICY_ROOT);
    const target = indexedItem("target", `sha256:${"a".repeat(64)}`, 128);
    const exact = indexedItem("exact", target.contentFingerprint!, 128);
    const sameSize = indexedItem("same-size", `sha256:${"b".repeat(64)}`, 128);
    const evidence = buildEvidenceBundle({
      context: {
        ancestors: [],
        archive: {
          identityComponents: [],
          isArchive: false,
          isConfigured: false,
          isFrozen: false,
        },
        declaredActiveDealId: "deal-alpha",
        declaredContextLocator: "context:active-deal",
        observedDeals: [
          { dealId: "deal-alpha", sourceLocator: "drive:path:deal-alpha" },
          { dealId: "deal-beta", sourceLocator: "drive:path:deal-beta" },
        ],
        protectedFlags: [],
      },
      items: [target, exact, sameSize],
      pack,
      targetId: target.id,
    });

    expect(evidence.duplicateCandidates.map((entry) => entry.itemId)).toEqual([
      "exact",
    ]);
    expect(evidence.bundle.conflicts.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["CONTRADICTORY_PATHS", "CROSS_DEAL_REFERENCE"]),
    );
    expect(
      evidence.bundle.conflicts.some((entry) =>
        entry.message.includes("same-size"),
      ),
    ).toBe(false);
  });

  test("preserves protected archives and resolves policy contradictions through human gates", async () => {
    const pack = await loadPolicyPack(POLICY_ROOT);
    const target = indexedItem(
      "protected-target",
      `sha256:${"c".repeat(64)}`,
      96,
    );
    const evidence = buildEvidenceBundle({
      context: {
        ancestors: [],
        archive: {
          identityComponents: ["deal", "sender", "date"],
          isArchive: true,
          isConfigured: true,
          isFrozen: true,
        },
        declaredActiveDealId: null,
        declaredContextLocator: "context:none",
        observedDeals: [],
        protectedFlags: ["data-room", "signed-document"],
      },
      items: [target],
      pack,
      targetId: target.id,
    });

    expect(evidence.reviewState).toBe("NEEDS_REVIEW");
    expect(evidence.context.protected.actionType).toBe("NEEDS_REVIEW");
    expect(evidence.context.archive).toMatchObject({
      actionType: "PRESERVE_ARCHIVE",
      preserveHierarchy: true,
    });
    expect(listMaterialQuestions(pack)).toHaveLength(1);
    expect(listMaterialQuestions(pack)[0]).toMatchObject({
      material: true,
      reasonCode: "PAISANO.COMMUNICATIONS.PATH_DECISION_REQUIRED",
    });
    expect(resolveEntityAlias(pack, "Paisano Capital Group")).toMatchObject({
      canonicalEntityId: null,
      status: "NEEDS_REVIEW",
    });
    expect(
      evaluateShortcut(pack, {
        batchDate: "2026-08-08",
        destinationFolderId: "bookkeeping-2026-08-08",
        destinationFolderName: "Bookkeeping Handoff",
        existingDestinationFolderIds: ["bookkeeping-2026-08-01"],
        sourceId: "synthetic-bookkeeping-source",
      }),
    ).toMatchObject({
      actionType: "CREATE_SHORTCUT",
      allowed: true,
      reasonCode: "PAISANO.SHORTCUT.BOOKKEEPING_DATED_BATCH",
    });
  });

  test("fails a mutation-shaped model response closed with no tool capability", async () => {
    const pack = await loadPolicyPack(POLICY_ROOT);
    const target = indexedItem("model-target", `sha256:${"d".repeat(64)}`, 64);
    const evidence = buildEvidenceBundle({
      context: {
        ancestors: [],
        archive: {
          identityComponents: [],
          isArchive: false,
          isConfigured: false,
          isFrozen: false,
        },
        declaredActiveDealId: null,
        declaredContextLocator: "context:none",
        observedDeals: [],
        protectedFlags: [],
      },
      items: [target],
      pack,
      targetId: target.id,
    });
    const provider = new DeterministicFakeModelProvider([
      {
        purpose: "analyst:classification",
        rawText: JSON.stringify({
          actionType: "DELETE",
          tools: ["apply"],
        }),
        usage: { inputTokens: 8, outputTokens: 4 },
      },
    ]);
    const outcome = await new ReasoningCoordinator({ provider }).analyze({
      evidence,
      limits: { maxRetries: 0 },
    });

    expect(outcome).toMatchObject({
      failure: { code: "INVALID_MODEL_OUTPUT" },
      status: "NEEDS_REVIEW",
      suggestion: { actionType: "NEEDS_REVIEW" },
    });
    expect(provider.transcript).toHaveLength(1);
    expect(provider.transcript[0]?.responseContract).toEqual({
      allowedActionTypes: [
        "KEEP",
        "RENAME",
        "CREATE_SHORTCUT",
        "PRESERVE_ARCHIVE",
        "NEEDS_REVIEW",
      ],
      mutationAllowed: false,
      schemaId: "dvw.reasoning-suggestion.v1",
      tools: [],
    });
  });
});
