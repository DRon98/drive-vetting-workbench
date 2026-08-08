import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { EvidenceBundleSchema, type ScanCoverage } from "@dvw/core";
import { buildEvidenceBundle } from "@dvw/evidence-builder";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import { loadPolicyPack } from "@dvw/policy-engine";

const temporaryDirectories: string[] = [];
const observedTime = "2026-08-07T12:00:00.000Z";
const fingerprint = `sha256:${"c".repeat(64)}`;
const PAISANO_PACK_ROOT = fileURLToPath(
  new URL("../../../packs/paisano", import.meta.url),
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dvw-evidence-integration-"));
  temporaryDirectories.push(directory);
  return join(directory, "evidence.sqlite");
}

describe("scan evidence to deterministic bundle", () => {
  test("builds a schema-valid bounded packet from an active SQLite generation", async () => {
    const coverage: ScanCoverage = {
      deniedItems: [],
      exportsAttempted: 1,
      generationId: "generation-builder",
      itemCount: 1,
      pageTokensConsumed: [],
      rootId: "root",
      state: "Complete",
      unsupportedTypes: [],
      warnings: [],
    };
    const store = EvidenceStore.rebuildFromFixture(databasePath(), {
      coverage,
      generation: {
        generationId: "generation-builder",
        rootId: "root",
        startedAt: observedTime,
      },
      items: [
        {
          contentFingerprint: fingerprint,
          contentLocator: "provider:invoice#export:text/plain",
          createdTime: observedTime,
          extractedSnippet: "From: billing@example.test\nInvoice",
          id: "invoice",
          mimeType: "application/pdf",
          modifiedTime: observedTime,
          name: "2026-07-15 Hotel Paisano Invoice.pdf",
          parentIds: ["folder-deal-alpha"],
          permissions: { canRead: true, canWrite: false },
          scanGeneration: "generation-builder",
          shortcutTargetId: null,
          sizeBytes: 128,
          trashed: false,
        },
      ],
    });
    const pack = await loadPolicyPack(PAISANO_PACK_ROOT);
    const input = {
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
      items: store.listActiveItems(),
      pack,
      targetId: "invoice",
    } as const;

    const first = buildEvidenceBundle(input);
    const second = buildEvidenceBundle(input);

    expect(first).toEqual(second);
    expect(EvidenceBundleSchema.parse(first.bundle)).toEqual(first.bundle);
    expect(first.scanGeneration).toBe("generation-builder");
    expect(first.policyVersion).toBe("1.0.0");
    expect(
      first.bundle.observedFacts.every((fact) =>
        first.bundle.sourceLocators.includes(fact.sourceLocator),
      ),
    ).toBe(true);
    const derivedLocators = [
      ...first.bundle.matchedRules.map((rule) => rule.policyLocator),
      ...first.namingParts.flatMap((part) => part.sourceLocators),
      ...first.duplicateCandidates.flatMap(
        (duplicate) => duplicate.sourceLocators,
      ),
    ];
    expect(
      derivedLocators.every((locator) =>
        first.bundle.sourceLocators.includes(locator),
      ),
    ).toBe(true);
    expect(JSON.stringify(first).length).toBeLessThan(32_000);
    store.close();
  });
});
