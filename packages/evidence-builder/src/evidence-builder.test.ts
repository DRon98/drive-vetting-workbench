import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { IndexedItem } from "@dvw/evidence-store-sqlite";
import { loadPolicyPack, type ValidatedPolicyPack } from "@dvw/policy-engine";
import {
  buildEvidenceBundle,
  EvidenceBuilderError,
  type EvidenceBuildContext,
} from "./index.js";

const PAISANO_PACK_ROOT = fileURLToPath(
  new URL("../../../packs/paisano", import.meta.url),
);
const observedTime = "2026-08-07T12:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
let pack: ValidatedPolicyPack;

beforeAll(async () => {
  pack = await loadPolicyPack(PAISANO_PACK_ROOT);
});

function item(
  id: string,
  name: string,
  overrides: Partial<IndexedItem> = {},
): IndexedItem {
  return {
    contentFingerprint: HASH_A,
    contentLocator: `provider:${id}#export:text/plain`,
    createdTime: observedTime,
    extractedSnippet:
      "From: synthetic.sender@example.test\nSynthetic fixture evidence.",
    id,
    mimeType: "application/pdf",
    modifiedTime: observedTime,
    name,
    normalizedName: name.toLocaleLowerCase("en-US"),
    parentIds: ["folder-deal-alpha"],
    permissions: { canRead: true, canWrite: false },
    scanGeneration: "generation-evidence",
    shortcutTargetId: null,
    sizeBytes: 512,
    trashed: false,
    ...overrides,
  };
}

function context(
  overrides: Partial<EvidenceBuildContext> = {},
): EvidenceBuildContext {
  return {
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
    ...overrides,
  };
}

describe("deterministic evidence bundles", () => {
  test("builds simple document-type and naming candidates", () => {
    const target = item(
      "simple-invoice",
      "2026-07-15 Hotel Paisano Invoice 2048.pdf",
      { extractedSnippet: "From: billing@example.test\nInvoice 2048" },
    );

    const first = buildEvidenceBundle({
      context: context(),
      items: [target],
      pack,
      targetId: target.id,
    });
    const second = buildEvidenceBundle({
      context: context(),
      items: [target],
      pack,
      targetId: target.id,
    });

    expect(first).toEqual(second);
    expect(first.bundle.candidateDocumentTypes).toContainEqual({
      confidence: 0.98,
      documentTypeId: "invoice",
    });
    expect(first.bundle.candidateEntities).toContainEqual({
      confidence: 0.98,
      entityId: "hotel-paisano",
    });
    expect(first.namingParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "date", value: "2026-07-15" }),
        expect.objectContaining({ kind: "document-type", value: "invoice" }),
        expect.objectContaining({ kind: "entity", value: "hotel-paisano" }),
        expect.objectContaining({
          kind: "sender",
          value: "billing@example.test",
        }),
      ]),
    );
    expect(first).toMatchSnapshot("simple evidence bundle");
  });

  test("explains a strong duplicate and ignores equal size with different content", () => {
    const target = item("duplicate-source", "Hotel Paisano Agreement.pdf");
    const exactCopy = item("duplicate-copy", "Copy of Agreement.pdf");
    const sameSizeDifferentContent = item(
      "same-size-different-content",
      "Unrelated Agreement.pdf",
      { contentFingerprint: HASH_B },
    );

    const result = buildEvidenceBundle({
      context: context(),
      items: [sameSizeDifferentContent, exactCopy, target],
      pack,
      targetId: target.id,
    });

    expect(
      result.duplicateCandidates.map((candidate) => candidate.itemId),
    ).toEqual(["duplicate-copy"]);
    expect(result.bundle.conflicts).toContainEqual(
      expect.objectContaining({ code: "EXACT_DUPLICATE", material: false }),
    );
    expect(result).toMatchSnapshot("duplicate evidence bundle");
  });

  test("blocks a reference document observed under another deal", () => {
    const target = item(
      "cross-deal-reference",
      "Hotel Paisano Closing Record.pdf",
      {
        parentIds: ["folder-deal-beta"],
      },
    );

    const result = buildEvidenceBundle({
      context: context({
        ancestors: [
          {
            id: "folder-deal-beta",
            name: "Deal Beta Reference",
            sourceLocator: "drive:item:folder-deal-beta#name",
          },
        ],
        observedDeals: [
          {
            dealId: "deal-beta",
            sourceLocator: "drive:path:folder-deal-beta",
          },
        ],
      }),
      items: [target],
      pack,
      targetId: target.id,
    });

    expect(result.reviewState).toBe("NEEDS_REVIEW");
    expect(result.bundle.conflicts).toContainEqual(
      expect.objectContaining({ code: "CROSS_DEAL_REFERENCE", material: true }),
    );
    expect(result).toMatchSnapshot("cross-deal evidence bundle");
  });

  test("retains protected target context and matched policy rules", () => {
    const target = item(
      "protected-original",
      "Signed Hotel Paisano Agreement.pdf",
    );

    const result = buildEvidenceBundle({
      context: context({ protectedFlags: ["data-room", "signed-document"] }),
      items: [target],
      pack,
      targetId: target.id,
    });

    expect(result.context.protected.actionType).toBe("NEEDS_REVIEW");
    expect(result.context.protected.flags).toEqual([
      "data-room",
      "signed-document",
    ]);
    expect(result.bundle.conflicts).toContainEqual(
      expect.objectContaining({ code: "PROTECTED_TARGET", material: true }),
    );
    expect(result).toMatchSnapshot("protected evidence bundle");
  });

  test("retains archive identity and hierarchy-preservation context", () => {
    const target = item("archive-record", "2024-06-01 Sender Archive", {
      contentFingerprint: null,
      contentLocator: null,
      extractedSnippet: null,
      mimeType: "application/vnd.google-apps.folder",
      sizeBytes: null,
    });

    const result = buildEvidenceBundle({
      context: context({
        archive: {
          identityComponents: ["date", "deal", "sender", "source"],
          isArchive: true,
          isConfigured: true,
          isFrozen: true,
        },
        protectedFlags: ["configured-archive"],
      }),
      items: [target],
      pack,
      targetId: target.id,
    });

    expect(result.context.archive).toMatchObject({
      actionType: "PRESERVE_ARCHIVE",
      preserveHierarchy: true,
    });
    expect(result.bundle.observedFacts).toContainEqual(
      expect.objectContaining({ field: "archive.identityComponents" }),
    );
    expect(result).toMatchSnapshot("archive evidence bundle");
  });

  test("fails closed when the complete evidence packet exceeds its byte budget", () => {
    const target = item("bounded-packet", "Hotel Paisano Invoice.pdf");

    expect(() =>
      buildEvidenceBundle({
        context: context(),
        items: [target],
        options: { maxPacketBytes: 64 },
        pack,
        targetId: target.id,
      }),
    ).toThrowError(EvidenceBuilderError);
  });

  test("makes an unclassified archive review-required", () => {
    const target = item("unclassified-archive", "Legacy Archive", {
      contentFingerprint: null,
      contentLocator: null,
      extractedSnippet: null,
      mimeType: "application/vnd.google-apps.folder",
      sizeBytes: null,
    });

    const result = buildEvidenceBundle({
      context: context({
        archive: {
          identityComponents: [],
          isArchive: true,
          isConfigured: false,
          isFrozen: false,
        },
      }),
      items: [target],
      pack,
      targetId: target.id,
    });

    expect(result.context.archive.actionType).toBe("NEEDS_REVIEW");
    expect(result.reviewState).toBe("NEEDS_REVIEW");
    expect(result.bundle.conflicts.map((conflict) => conflict.code)).toContain(
      "ARCHIVE_REVIEW_REQUIRED",
    );
  });

  test("surfaces locator truncation as an evidence-budget conflict", () => {
    const target = item("locator-budget", "Hotel Paisano Invoice.pdf");

    const result = buildEvidenceBundle({
      context: context({
        ancestors: [
          {
            id: "ancestor-a",
            name: "Hotel Paisano Invoice",
            sourceLocator: "drive:item:ancestor-a#name",
          },
          {
            id: "ancestor-b",
            name: "Hotel Paisano Invoice",
            sourceLocator: "drive:item:ancestor-b#name",
          },
        ],
      }),
      items: [target],
      options: { maxLocatorsPerCandidate: 1 },
      pack,
      targetId: target.id,
    });

    expect(result.reviewState).toBe("NEEDS_REVIEW");
    expect(result.bundle.conflicts.map((conflict) => conflict.code)).toContain(
      "EVIDENCE_BUDGET_EXCEEDED",
    );
  });

  test("reports multiple entities, uncertain dates, and contradictory paths", () => {
    const target = item(
      "conflicted-context",
      "2026-01-01 2026-02-02 Hotel Paisano Other Entity Agreement.pdf",
    );
    const conflictedPack: ValidatedPolicyPack = {
      ...pack,
      entityAliases: [
        ...pack.entityAliases,
        { alias: "Other Entity", entityId: "other-entity" },
      ],
    };

    const result = buildEvidenceBundle({
      context: context({
        observedDeals: [
          {
            dealId: "deal-alpha",
            sourceLocator: "drive:path:folder-deal-alpha",
          },
          {
            dealId: "deal-beta",
            sourceLocator: "drive:path:folder-deal-beta",
          },
        ],
      }),
      items: [target],
      pack: conflictedPack,
      targetId: target.id,
    });

    expect(result.bundle.conflicts.map((conflict) => conflict.code)).toEqual(
      expect.arrayContaining([
        "CONTRADICTORY_PATHS",
        "CROSS_DEAL_REFERENCE",
        "MULTIPLE_ENTITIES",
        "UNCERTAIN_DATE",
      ]),
    );
  });

  test("uses a specific MIME type as a deterministic document-type cue", () => {
    const target = item("email-message", "Client update.eml", {
      mimeType: "message/rfc822",
    });

    const result = buildEvidenceBundle({
      context: context(),
      items: [target],
      pack,
      targetId: target.id,
    });

    expect(result.bundle.candidateDocumentTypes).toContainEqual({
      confidence: 0.92,
      documentTypeId: "correspondence",
    });
    expect(result.namingParts).toContainEqual(
      expect.objectContaining({
        kind: "document-type",
        sourceLocators: ["drive:item:email-message#mimeType"],
        value: "correspondence",
      }),
    );
  });
});
