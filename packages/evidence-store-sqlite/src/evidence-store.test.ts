import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservedItem, ScanCoverage } from "@dvw/core";
import { afterEach, describe, expect, test } from "vitest";
import { EvidenceStore } from "./evidence-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dvw-evidence-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "evidence.sqlite");
}

function observedItem(
  generationId: string,
  overrides: Partial<ObservedItem> = {},
): ObservedItem {
  return {
    contentFingerprint: "sha256:alpha",
    createdTime: "2026-01-01T00:00:00.000Z",
    id: "item-alpha",
    mimeType: "application/pdf",
    modifiedTime: "2026-01-02T00:00:00.000Z",
    name: "Alpha.pdf",
    parentIds: ["root"],
    permissions: { canRead: true, canWrite: false },
    scanGeneration: generationId,
    shortcutTargetId: null,
    trashed: false,
    ...overrides,
  };
}

function completeCoverage(
  generationId: string,
  itemCount: number,
  overrides: Partial<ScanCoverage> = {},
): ScanCoverage {
  return {
    deniedItems: [],
    exportsAttempted: 0,
    generationId,
    itemCount,
    pageTokensConsumed: ["page-1"],
    rootId: "root",
    state: "Complete",
    unsupportedTypes: [],
    warnings: [],
    ...overrides,
  };
}

function beginGeneration(store: EvidenceStore, generationId: string): void {
  store.beginGeneration({
    generationId,
    rootId: "root",
    startedAt: "2026-01-03T00:00:00.000Z",
  });
}

function stageItem(store: EvidenceStore, item: ObservedItem): void {
  store.stageItem({
    ...item,
    contentLocator: `fixture:${item.id}`,
    extractedSnippet: `Synthetic evidence for ${item.name}`,
    sizeBytes: 128,
  });
}

test("applies migrations to an empty database and skips them on repeat", () => {
  const store = new EvidenceStore(databasePath());

  expect(store.migrate()).toEqual({
    applied: ["001_evidence", "002_decisions", "003_execution"],
    skipped: [],
  });
  expect(store.migrate()).toEqual({
    applied: [],
    skipped: ["001_evidence", "002_decisions", "003_execution"],
  });

  store.close();
});

describe("scan generation publication", () => {
  test("keeps staging data invisible and preserves the previous active generation after failure", () => {
    const store = new EvidenceStore(databasePath());
    store.migrate();
    beginGeneration(store, "generation-1");
    stageItem(store, observedItem("generation-1"));
    store.recordCoverage(completeCoverage("generation-1", 1));
    store.publishGeneration("generation-1");
    expect(store.getGeneration("generation-1")?.state).toBe("Active");
    expect(store.getGeneration("generation-1")?.completedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u,
    );

    beginGeneration(store, "generation-2");
    stageItem(
      store,
      observedItem("generation-2", {
        contentFingerprint: "sha256:beta",
        name: "Beta.pdf",
      }),
    );

    expect(store.activeGenerationId()).toBe("generation-1");
    expect(store.getActiveItemById("item-alpha")?.name).toBe("Alpha.pdf");
    expect(store.findActiveItemsByNormalizedName("beta.pdf")).toEqual([]);
    expect(() => store.publishGeneration("generation-2")).toThrow(
      /complete coverage/u,
    );

    store.failGeneration("generation-2", {
      code: "PAGE_FETCH_FAILED",
      detail: "Synthetic page 2 failed.",
      itemId: null,
    });

    expect(store.activeGenerationId()).toBe("generation-1");
    expect(store.getGeneration("generation-2")?.state).toBe("Failed");
    expect(store.listGenerationIssues("generation-2")).toEqual([
      {
        code: "PAGE_FETCH_FAILED",
        detail: "Synthetic page 2 failed.",
        itemId: null,
      },
    ]);
    store.close();
  });

  test("rolls back every local write when a transaction fails", () => {
    const store = new EvidenceStore(databasePath());
    store.migrate();

    expect(() =>
      store.withTransaction(() => {
        beginGeneration(store, "rolled-back-generation");
        throw new Error("synthetic transaction failure");
      }),
    ).toThrow("synthetic transaction failure");

    expect(store.getGeneration("rolled-back-generation")).toBeNull();
    expect(store.activeGenerationId()).toBeNull();
    store.close();
  });

  test("rejects asynchronous transaction callbacks before committing", () => {
    const store = new EvidenceStore(databasePath());
    store.migrate();

    expect(() =>
      store.withTransaction(() => {
        beginGeneration(store, "async-generation");
        return Promise.resolve();
      }),
    ).toThrow(/synchronous/u);

    expect(store.getGeneration("async-generation")).toBeNull();
    store.close();
  });

  test("refuses publication when coverage does not match staged items", () => {
    const store = new EvidenceStore(databasePath());
    store.migrate();
    beginGeneration(store, "generation-count-mismatch");
    stageItem(store, observedItem("generation-count-mismatch"));
    store.recordCoverage(completeCoverage("generation-count-mismatch", 2));

    expect(() => store.publishGeneration("generation-count-mismatch")).toThrow(
      /item count/u,
    );
    expect(store.activeGenerationId()).toBeNull();
    expect(store.getGeneration("generation-count-mismatch")?.state).toBe(
      "Staging",
    );
    store.close();
  });

  test("supersedes the previous active generation in the publication transaction", () => {
    const store = new EvidenceStore(databasePath());
    store.migrate();
    beginGeneration(store, "generation-old");
    stageItem(store, observedItem("generation-old"));
    store.recordCoverage(completeCoverage("generation-old", 1));
    store.publishGeneration("generation-old");

    beginGeneration(store, "generation-new");
    stageItem(
      store,
      observedItem("generation-new", {
        contentFingerprint: "sha256:new",
        name: "New.pdf",
      }),
    );
    store.recordCoverage(completeCoverage("generation-new", 1));
    store.publishGeneration("generation-new");

    expect(store.getGeneration("generation-old")?.state).toBe("Superseded");
    expect(store.getGeneration("generation-new")?.state).toBe("Active");
    expect(store.activeGenerationId()).toBe("generation-new");
    expect(store.getActiveItemById("item-alpha")?.name).toBe("New.pdf");
    store.close();
  });
});

describe("evidence queries", () => {
  test("preserves stable IDs and distinguishes same-size content by fingerprint", () => {
    const store = new EvidenceStore(databasePath());
    store.migrate();
    beginGeneration(store, "generation-fingerprints");
    stageItem(
      store,
      observedItem("generation-fingerprints", {
        contentFingerprint: "sha256:first",
        id: "stable-first",
        name: "Duplicate.pdf",
      }),
    );
    stageItem(
      store,
      observedItem("generation-fingerprints", {
        contentFingerprint: "sha256:second",
        id: "stable-second",
        name: "Duplicate.pdf",
      }),
    );
    store.recordCoverage(completeCoverage("generation-fingerprints", 2));
    store.publishGeneration("generation-fingerprints");

    const matches = store.findActiveItemsByNormalizedName("duplicate.pdf");
    expect(matches.map((item) => item.id)).toEqual([
      "stable-first",
      "stable-second",
    ]);
    expect(matches.map((item) => item.sizeBytes)).toEqual([128, 128]);
    expect(matches.map((item) => item.contentFingerprint)).toEqual([
      "sha256:first",
      "sha256:second",
    ]);
    expect(store.getActiveItemById("stable-second")?.id).toBe("stable-second");
    store.close();
  });

  test("normalizes Unicode names and traverses typed relations in the active graph", () => {
    const store = new EvidenceStore(databasePath());
    store.migrate();
    beginGeneration(store, "generation-graph");
    stageItem(
      store,
      observedItem("generation-graph", {
        id: "root",
        mimeType: "application/vnd.google-apps.folder",
        name: "Root",
        parentIds: [],
      }),
    );
    stageItem(
      store,
      observedItem("generation-graph", {
        id: "folder",
        mimeType: "application/vnd.google-apps.folder",
        name: "Folder",
        parentIds: ["root"],
      }),
    );
    stageItem(
      store,
      observedItem("generation-graph", {
        id: "document",
        name: "  RÉSUMÉ   FY24.pdf  ",
        parentIds: ["folder"],
      }),
    );
    stageItem(
      store,
      observedItem("generation-graph", {
        id: "shortcut",
        mimeType: "application/vnd.google-apps.shortcut",
        name: "Résumé shortcut",
        shortcutTargetId: "document",
      }),
    );
    for (const [kind, targetId] of [
      ["Entity", "entity:paisano"],
      ["Evidence", "evidence:classification"],
      ["Proposal", "proposal:rename-document"],
      ["Receipt", "receipt:verified-write"],
    ] as const) {
      store.stageRelation({
        generationId: "generation-graph",
        kind,
        sourceItemId: "document",
        sourceLocator: `synthetic:${kind.toLowerCase()}`,
        targetId,
      });
    }
    store.recordCoverage(
      completeCoverage("generation-graph", 4, {
        deniedItems: [{ itemId: "denied-item", reason: "permission denied" }],
        exportsAttempted: 1,
        unsupportedTypes: [
          { itemId: "unsupported-item", mimeType: "application/x-synthetic" },
        ],
        warnings: ["Synthetic coverage warning."],
      }),
    );
    store.publishGeneration("generation-graph");

    expect(
      store.findActiveItemsByNormalizedName("re\u0301sume\u0301 fy24.pdf")[0]
        ?.id,
    ).toBe("document");
    expect(
      store
        .traverseActiveRelations("document", {
          direction: "outbound",
          maxDepth: 2,
        })
        .map(({ depth, kind, targetId }) => ({ depth, kind, targetId })),
    ).toEqual([
      { depth: 1, kind: "Entity", targetId: "entity:paisano" },
      { depth: 1, kind: "Evidence", targetId: "evidence:classification" },
      { depth: 1, kind: "Parent", targetId: "folder" },
      { depth: 1, kind: "Proposal", targetId: "proposal:rename-document" },
      { depth: 1, kind: "Receipt", targetId: "receipt:verified-write" },
      { depth: 2, kind: "Parent", targetId: "root" },
    ]);
    expect(
      store
        .traverseActiveRelations("shortcut", {
          direction: "outbound",
          maxDepth: 1,
        })
        .map(({ kind, targetId }) => ({ kind, targetId })),
    ).toEqual([
      { kind: "Parent", targetId: "root" },
      { kind: "Shortcut", targetId: "document" },
    ]);
    expect(store.getActiveCoverage()?.warnings).toEqual([
      "Synthetic coverage warning.",
    ]);
    expect(store.listGenerationIssues("generation-graph")).toEqual([
      {
        code: "DENIED_ITEM",
        detail: "permission denied",
        itemId: "denied-item",
      },
      {
        code: "UNSUPPORTED_TYPE",
        detail: "application/x-synthetic",
        itemId: "unsupported-item",
      },
      {
        code: "WARNING",
        detail: "Synthetic coverage warning.",
        itemId: null,
      },
    ]);
    store.close();
  });

  test("uses full-text search for minimal snippets when SQLite supports it", () => {
    const store = new EvidenceStore(databasePath());
    store.migrate();
    beginGeneration(store, "generation-search");
    store.stageItem({
      ...observedItem("generation-search", {
        id: "search-result",
        name: "Quarterly report.pdf",
      }),
      contentLocator: "fixture:search-result#page=1",
      extractedSnippet: "Synthetic zephyr reconciliation evidence.",
      sizeBytes: 64,
    });
    store.recordCoverage(completeCoverage("generation-search", 1));
    store.publishGeneration("generation-search");

    const query = store.supportsFullTextSearch() ? "zephyr" : "quarterly";
    expect(store.searchActiveItems(query).map((item) => item.id)).toEqual([
      "search-result",
    ]);
    store.close();
  });
});

test("rebuilds a removed test database to an equivalent deterministic snapshot", () => {
  const path = databasePath();
  const fixture = {
    coverage: completeCoverage("fixture-generation", 2),
    generation: {
      generationId: "fixture-generation",
      rootId: "root",
      startedAt: "2026-02-01T00:00:00.000Z",
    },
    items: [
      {
        ...observedItem("fixture-generation", {
          id: "fixture-a",
          name: "A.pdf",
        }),
        contentLocator: "fixture:a#page=1",
        extractedSnippet: "Synthetic A evidence.",
        sizeBytes: 10,
      },
      {
        ...observedItem("fixture-generation", {
          contentFingerprint: "sha256:fixture-b",
          id: "fixture-b",
          name: "B.pdf",
        }),
        contentLocator: "fixture:b#page=1",
        extractedSnippet: "Synthetic B evidence.",
        sizeBytes: 10,
      },
    ],
    relations: [
      {
        generationId: "fixture-generation",
        kind: "Evidence" as const,
        sourceItemId: "fixture-b",
        sourceLocator: "fixture:evidence-b",
        targetId: "evidence:b",
      },
    ],
  };

  const firstStore = EvidenceStore.rebuildFromFixture(path, fixture);
  const firstSnapshot = firstStore.exportActiveSnapshot();
  firstStore.close();
  rmSync(path);

  const secondStore = EvidenceStore.rebuildFromFixture(path, fixture);
  const secondSnapshot = secondStore.exportActiveSnapshot();
  secondStore.close();

  expect(secondSnapshot).toEqual(firstSnapshot);
  expect(secondSnapshot).toMatchSnapshot("fixture rebuild");
});
