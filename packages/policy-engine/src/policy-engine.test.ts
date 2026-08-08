import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  evaluateArchive,
  evaluateProtectedItem,
  evaluateShortcut,
  listMaterialQuestions,
  loadPolicyPack,
  resolveEntityAlias,
  validatePolicyPack,
} from "./index.js";

const PAISANO_PACK_ROOT = fileURLToPath(
  new URL("../../../packs/paisano", import.meta.url),
);

async function loadPaisanoPack() {
  return loadPolicyPack(PAISANO_PACK_ROOT);
}

describe("Paisano policy pack", () => {
  test("loads all versioned rule sections from disk", async () => {
    const pack = await loadPaisanoPack();

    expect(pack.version).toBe("1.0.0");
    expect(pack.taxonomy.length).toBeGreaterThan(0);
    expect(pack.namingRules.length).toBeGreaterThan(0);
    expect(pack.documentTypes.length).toBeGreaterThan(0);
    expect(pack.entityAliases.length).toBeGreaterThan(0);
    expect(pack.protectedItems.length).toBeGreaterThan(0);
    expect(pack.archiveRules.length).toBeGreaterThan(0);
    expect(pack.shortcutRules.exceptions.length).toBeGreaterThan(0);
    expect(pack.precedents.length).toBeGreaterThan(0);
  });

  test("binds every policy section byte-for-byte to the version manifest", async () => {
    const manifest = JSON.parse(
      await readFile(join(PAISANO_PACK_ROOT, "pack.json"), "utf8"),
    ) as {
      readonly integrity: {
        readonly algorithm: string;
        readonly files: Readonly<Record<string, string>>;
      };
    };
    expect(manifest.integrity.algorithm).toBe("sha256");
    expect(Object.keys(manifest.integrity.files)).toHaveLength(8);
    for (const [filename, expected] of Object.entries(
      manifest.integrity.files,
    )) {
      const text = await readFile(join(PAISANO_PACK_ROOT, filename), "utf8");
      expect(createHash("sha256").update(text).digest("hex")).toBe(expected);
    }
  });

  test("turns the two communications destinations into one material question", async () => {
    const pack = await loadPaisanoPack();

    expect(listMaterialQuestions(pack)).toMatchSnapshot();
  });

  test("rejects invalid versions and contradictory active aliases", async () => {
    const pack = await loadPaisanoPack();

    expect(() => validatePolicyPack({ ...pack, version: "latest" })).toThrow(
      /semantic version/u,
    );
    expect(() =>
      validatePolicyPack({
        ...pack,
        entityAliases: [
          ...pack.entityAliases,
          { alias: "THE PAISANO", entityId: "another-entity" },
        ],
      }),
    ).toThrow(/contradictory entity alias/u);
  });

  test("rejects contradictory protected rules and reused shortcut exception ids", async () => {
    const pack = await loadPaisanoPack();

    expect(() =>
      validatePolicyPack({
        ...pack,
        protectedItems: [
          ...pack.protectedItems,
          {
            reasonCode: "PAISANO.PROTECTED.CONFLICTING_DATA_ROOM_RULE",
            selector: "flag:data-room",
          },
        ],
      }),
    ).toThrow(/contradictory protected item rule/u);
    expect(() =>
      validatePolicyPack({
        ...pack,
        shortcutRules: {
          ...pack.shortcutRules,
          exceptions: [
            ...pack.shortcutRules.exceptions,
            {
              id: "bookkeeping-handoff-dated-batches",
              maxPerSource: 2,
              mode: "LIMITED_BATCH",
              reasonCode: "PAISANO.SHORTCUT.CONFLICTING_BATCH",
              selector: "folder-name:Another Handoff",
            },
          ],
        },
      }),
    ).toThrow(/contradictory shortcut exception id/u);
  });
});

describe("shortcut policy", () => {
  test("blocks a second normal organizational shortcut", async () => {
    const pack = await loadPaisanoPack();

    expect(
      evaluateShortcut(pack, {
        batchDate: null,
        destinationFolderId: "folder-destination-b",
        destinationFolderName: "Working Files",
        existingDestinationFolderIds: ["folder-destination-a"],
        sourceId: "file-source-1",
      }),
    ).toMatchSnapshot();
  });

  test("allows distinct dated Bookkeeping Handoff shortcuts", async () => {
    const pack = await loadPaisanoPack();

    expect(
      evaluateShortcut(pack, {
        batchDate: "2026-08-07",
        destinationFolderId: "bookkeeping-2026-08-07",
        destinationFolderName: "Bookkeeping Handoff",
        existingDestinationFolderIds: ["bookkeeping-2026-07-31"],
        sourceId: "file-source-2",
      }),
    ).toMatchSnapshot();
  });
});

describe("protected and archive policy", () => {
  test("makes protected item matches explicit and review-required", async () => {
    const pack = await loadPaisanoPack();

    expect(
      evaluateProtectedItem(pack, {
        flags: ["data-room", "signed-document"],
        itemId: "file-protected-1",
      }),
    ).toMatchSnapshot();
  });

  test("preserves a frozen archive and its identity-bearing hierarchy", async () => {
    const pack = await loadPaisanoPack();

    const result = evaluateArchive(pack, {
      identityComponents: ["deal", "sender", "date"],
      isArchive: true,
      isConfigured: true,
      isFrozen: true,
      itemId: "folder-archive-1",
    });

    expect(result).toMatchSnapshot();
    expect(result.actionType).not.toBe("RENAME");
  });
});

describe("entity aliases", () => {
  test("resolves only an exact configured alias", async () => {
    const pack = await loadPaisanoPack();

    expect(resolveEntityAlias(pack, "  THE PAISANO ")).toMatchSnapshot();
  });

  test("fails closed for a wrong alias instead of inventing an entity", async () => {
    const pack = await loadPaisanoPack();

    expect(resolveEntityAlias(pack, "Paisano Capital Group")).toMatchSnapshot();
  });
});
