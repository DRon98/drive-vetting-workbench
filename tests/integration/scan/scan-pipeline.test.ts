import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ObservedItem } from "../../../packages/core/src/index.js";
import { createTextContentExtractor } from "../../../packages/content-extractor/src/index.js";
import {
  createInstrumentedFakeDrive,
  type FakeDriveFixture,
} from "../../../packages/drive-provider/src/index.js";
import { EvidenceStore } from "../../../packages/evidence-store-sqlite/src/index.js";
import {
  ScanPipelineError,
  scanFolder,
} from "../../../packages/scanner/src/index.js";

const temporaryDirectories: string[] = [];
const observedTime = "2026-08-07T12:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dvw-scan-integration-"));
  temporaryDirectories.push(directory);
  return join(directory, "evidence.sqlite");
}

function observedItem(
  id: string,
  name: string,
  overrides: Partial<ObservedItem> = {},
): ObservedItem {
  return {
    contentFingerprint: `sha256:${id}`,
    createdTime: observedTime,
    id,
    mimeType: "text/plain",
    modifiedTime: observedTime,
    name,
    parentIds: ["root"],
    permissions: { canRead: true, canWrite: false },
    scanGeneration: "provider-observed",
    shortcutTargetId: null,
    trashed: false,
    ...overrides,
  };
}

function adversarialFixture(): FakeDriveFixture {
  return {
    rootIds: ["root"],
    items: [
      {
        item: observedItem("google-doc", "Google Native Memo", {
          mimeType: "application/vnd.google-apps.document",
        }),
        nativeExports: [
          { mimeType: "text/plain", text: "Synthetic native document" },
        ],
      },
      {
        item: observedItem("denied", "Denied Note", {
          permissions: {
            canRead: false,
            canWrite: false,
            deniedReason: "Synthetic permission gap",
          },
        }),
        readDenied: true,
      },
      {
        item: observedItem("binary", "Unsupported Binary", {
          mimeType: "application/x-synthetic-binary",
        }),
      },
      {
        item: observedItem("broken-shortcut", "Missing Target", {
          contentFingerprint: null,
          mimeType: "application/vnd.google-apps.shortcut",
          shortcutTargetId: "missing-target",
        }),
      },
      {
        item: observedItem("shortcut-a", "Cycle A", {
          contentFingerprint: null,
          mimeType: "application/vnd.google-apps.shortcut",
          shortcutTargetId: "shortcut-b",
        }),
      },
      {
        item: observedItem("shortcut-b", "Cycle B", {
          contentFingerprint: null,
          mimeType: "application/vnd.google-apps.shortcut",
          shortcutTargetId: "shortcut-a",
        }),
      },
      {
        item: observedItem("missing-export", "Native Export Gap", {
          mimeType: "application/vnd.google-apps.document",
        }),
      },
      {
        item: observedItem("final-page", "Final Page Relevant", {
          contentFingerprint: "sha256:final-page",
        }),
        nativeExports: [
          { mimeType: "text/plain", text: "Relevant final-page evidence" },
        ],
      },
    ],
  };
}

describe("read-only scan integration", () => {
  test("consumes every page, persists explicit gaps, and publishes atomically", async () => {
    const drive = createInstrumentedFakeDrive(adversarialFixture());
    const store = new EvidenceStore(databasePath());
    store.migrate();

    const result = await scanFolder({
      extractContent: true,
      extractor: createTextContentExtractor({ maxSnippetBytes: 128 }),
      generationId: "scan-complete",
      maxShortcutDepth: 8,
      pageSize: 2,
      provider: drive.read,
      rootId: "root",
      startedAt: observedTime,
      store,
    });

    expect(result).toMatchObject({
      extractedItemCount: 2,
      itemCount: 8,
      pageCount: 4,
      published: true,
    });
    expect(result.coverage).toMatchSnapshot("fixture coverage report");
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "BROKEN_SHORTCUT",
        "DENIED_ITEM",
        "SHORTCUT_CYCLE",
        "UNSUPPORTED_TYPE",
      ]),
    );
    expect(store.activeGenerationId()).toBe("scan-complete");
    expect(store.listActiveItems()).toHaveLength(8);
    expect(store.getActiveItemById("final-page")).toMatchObject({
      extractedSnippet: "Relevant final-page evidence",
      name: "Final Page Relevant",
      scanGeneration: "scan-complete",
    });
    expect(
      store.listGenerationIssues("scan-complete").map((issue) => issue.code),
    ).toEqual(expect.arrayContaining(["BROKEN_SHORTCUT", "SHORTCUT_CYCLE"]));
    expect(
      drive.calls.filter((call) => call.method === "listItems"),
    ).toHaveLength(4);
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
    store.close();
  });

  test("leaves the prior active generation queryable after a provider failure", async () => {
    const fixture: FakeDriveFixture = {
      items: [
        {
          item: observedItem("stable", "Stable Before Failure"),
          nativeExports: [{ mimeType: "text/plain", text: "stable" }],
        },
      ],
      rootIds: ["root"],
    };
    const drive = createInstrumentedFakeDrive(fixture);
    const store = new EvidenceStore(databasePath());
    store.migrate();
    await scanFolder({
      extractContent: false,
      generationId: "scan-prior",
      maxShortcutDepth: 8,
      pageSize: 10,
      provider: drive.read,
      rootId: "root",
      startedAt: observedTime,
      store,
    });
    drive.controls.failOnCall("listItems", 2, {
      code: "PROVIDER_FAILURE",
      itemId: "root",
      message: "Synthetic page failure",
      retryable: false,
    });

    await expect(
      scanFolder({
        extractContent: false,
        generationId: "scan-failed",
        maxShortcutDepth: 8,
        pageSize: 10,
        provider: drive.read,
        rootId: "root",
        startedAt: "2026-08-07T12:01:00.000Z",
        store,
      }),
    ).rejects.toBeInstanceOf(ScanPipelineError);
    expect(store.activeGenerationId()).toBe("scan-prior");
    expect(store.getActiveItemById("stable")?.name).toBe(
      "Stable Before Failure",
    );
    expect(store.getGeneration("scan-failed")?.state).toBe("Failed");
    expect(drive.writeCount).toBe(0);
    store.close();
  });

  test("can scan metadata without making content export calls", async () => {
    const drive = createInstrumentedFakeDrive(adversarialFixture());
    const store = new EvidenceStore(databasePath());
    store.migrate();

    const result = await scanFolder({
      extractContent: false,
      generationId: "scan-metadata-only",
      maxShortcutDepth: 8,
      pageSize: 20,
      provider: drive.read,
      rootId: "root",
      startedAt: observedTime,
      store,
    });

    expect(result.coverage.exportsAttempted).toBe(0);
    expect(drive.calls.some((call) => call.method === "exportItem")).toBe(
      false,
    );
    expect(drive.writeCount).toBe(0);
    store.close();
  });
});
