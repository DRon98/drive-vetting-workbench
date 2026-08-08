import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DriveLab,
  DriveLabError,
  LAB_SCENARIOS,
  LabManifestSchema,
  resolveSandboxPath,
  type LabEdit,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function sandbox(name = "lab"): string {
  const parent = mkdtempSync(join(tmpdir(), "dvw-drive-lab-"));
  temporaryDirectories.push(parent);
  return join(parent, name);
}

async function listAll(lab: DriveLab, pageSize = 2) {
  const items = [];
  const tokens: string[] = [];
  let pageToken: string | null = null;
  do {
    const result = await lab.read.listItems({
      pageSize,
      pageToken,
      rootId: lab.manifest.rootId,
      supportsAllDrives: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    items.push(...result.value.items);
    pageToken = result.value.nextPageToken;
    if (pageToken !== null) tokens.push(pageToken);
  } while (pageToken !== null);
  return { items, tokens };
}

describe("deterministic Drive Lab scenarios", () => {
  test("ships every named scenario with a stable initial snapshot", () => {
    expect(LAB_SCENARIOS).toEqual([
      "clean",
      "messy-paisano",
      "pagination-gap",
      "protected-archive",
      "shortcut-cycle",
      "stale-after-approval",
      "partial-failure",
    ]);
    const snapshots = LAB_SCENARIOS.map((scenario) => {
      const first = DriveLab.initialize(sandbox(`${scenario}-one`), scenario);
      const second = DriveLab.initialize(sandbox(`${scenario}-two`), scenario);
      expect(second.snapshot()).toEqual(first.snapshot());
      return { scenario, snapshotHash: first.snapshot().hash };
    });
    expect(new Set(snapshots.map((entry) => entry.snapshotHash)).size).toBe(
      snapshots.length,
    );
    expect(snapshots).toMatchSnapshot("named scenario snapshots");
  });

  test("matches the checked-in synthetic scenario catalog", () => {
    const catalog = JSON.parse(
      readFileSync(
        new URL("../../../fixtures/lab/scenarios.json", import.meta.url),
        "utf8",
      ),
    ) as {
      scenarios: Array<{
        name: string;
        proves: string[];
        rootId: string;
        snapshotHash: string;
      }>;
      version: number;
    };
    expect(catalog.version).toBe(1);
    expect(catalog.scenarios.map((entry) => entry.name)).toEqual(LAB_SCENARIOS);
    for (const fixture of catalog.scenarios) {
      const lab = DriveLab.initialize(
        sandbox(`fixture-${fixture.name}`),
        fixture.name as (typeof LAB_SCENARIOS)[number],
      );
      expect({
        rootId: lab.manifest.rootId,
        snapshotHash: lab.snapshot().hash,
      }).toEqual({
        rootId: fixture.rootId,
        snapshotHash: fixture.snapshotHash,
      });
      expect(fixture.proves.length).toBeGreaterThan(0);
    }
  });

  test("persists stable IDs, pagination, content, parents, and shortcuts", async () => {
    const lab = DriveLab.initialize(sandbox(), "messy-paisano");
    const first = await listAll(lab, 2);
    const reopened = DriveLab.open(lab.sandboxRoot);
    const second = await listAll(reopened, 2);

    expect(second).toEqual(first);
    expect(first.tokens.length).toBeGreaterThan(0);
    expect(first.items.every((item) => item.id.length > 0)).toBe(true);
    expect(first.items.some((item) => item.parentIds.length > 0)).toBe(true);
    expect(first.items.some((item) => item.shortcutTargetId !== null)).toBe(
      true,
    );
    const contentItem = first.items.find(
      (item) => item.id === "messy-invoice-draft",
    );
    expect(contentItem).toBeDefined();
    if (contentItem === undefined) throw new Error("Missing content fixture.");
    const exported = await lab.read.exportItem({
      exportMimeType: "text/plain",
      itemId: contentItem.id,
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error(exported.error.message);
    expect(new TextDecoder().decode(exported.value.bytes)).toContain(
      "Synthetic invoice",
    );
  });

  test("rejects structurally inconsistent manifest content metadata", () => {
    const lab = DriveLab.initialize(sandbox(), "clean");
    const manifest = lab.snapshot().manifest;
    const nodes = manifest.nodes.map((node) =>
      node.id === "clean-root"
        ? { ...node, exportMimeType: "text/plain" }
        : node,
    );
    expect(LabManifestSchema.safeParse({ ...manifest, nodes }).success).toBe(
      false,
    );
  });

  test("makes a page token stale after an explicit lab edit", async () => {
    const lab = DriveLab.initialize(sandbox(), "messy-paisano");
    const first = await lab.read.listItems({
      pageSize: 1,
      pageToken: null,
      rootId: lab.manifest.rootId,
      supportsAllDrives: true,
    });
    expect(first.ok && first.value.nextPageToken).not.toBeNull();
    if (!first.ok || first.value.nextPageToken === null) {
      throw new Error("Expected a Drive Lab page token.");
    }
    lab.applyEdit({
      itemId: "messy-invoice-draft",
      name: "Changed while paging.pdf",
      type: "rename",
    });
    await expect(
      lab.read.listItems({
        pageSize: 1,
        pageToken: first.value.nextPageToken,
        rootId: lab.manifest.rootId,
        supportsAllDrives: true,
      }),
    ).resolves.toMatchObject({ error: { code: "STALE_STATE" }, ok: false });
  });

  test("models every named failure scenario deterministically", async () => {
    const pagination = DriveLab.initialize(
      sandbox("pagination"),
      "pagination-gap",
    );
    const paged = await listAll(pagination, 100);
    expect(paged.items).toHaveLength(6);
    expect(paged.tokens).toHaveLength(3);
    await expect(
      pagination.read.getItem("pagination-item-6"),
    ).resolves.toMatchObject({ error: { code: "DENIED" }, ok: false });

    const archive = DriveLab.initialize(
      sandbox("archive"),
      "protected-archive",
    );
    await expect(
      archive.mutation.rename({
        expectedModifiedTime: archive.manifest.clockStart,
        name: "Unsafe rename.pdf",
        targetId: "protected-legal-original",
      }),
    ).resolves.toMatchObject({ error: { code: "DENIED" }, ok: false });

    const cycle = DriveLab.initialize(sandbox("cycle"), "shortcut-cycle");
    expect((await listAll(cycle)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cycle-a", shortcutTargetId: "cycle-b" }),
        expect.objectContaining({ id: "cycle-b", shortcutTargetId: "cycle-a" }),
      ]),
    );

    const stale = DriveLab.initialize(sandbox("stale"), "stale-after-approval");
    const approved = await stale.read.getItem("stale-target");
    if (!approved.ok || approved.value === null)
      throw new Error("Missing stale target.");
    stale.applyEdit({
      itemId: "stale-target",
      name: "Changed.pdf",
      type: "rename",
    });
    await expect(
      stale.mutation.rename({
        expectedModifiedTime: approved.value.modifiedTime,
        name: "Approved.pdf",
        targetId: approved.value.id,
      }),
    ).resolves.toMatchObject({ error: { code: "STALE_STATE" }, ok: false });

    const partial = DriveLab.initialize(sandbox("partial"), "partial-failure");
    const firstRename = await partial.mutation.rename({
      expectedModifiedTime: partial.manifest.clockStart,
      name: "One changed.pdf",
      targetId: "partial-one",
    });
    const secondRename = await partial.mutation.rename({
      expectedModifiedTime: partial.manifest.clockStart,
      name: "Two changed.pdf",
      targetId: "partial-two",
    });
    expect(firstRename.ok).toBe(true);
    expect(secondRename).toMatchObject({
      error: { code: "PROVIDER_FAILURE" },
      ok: false,
    });
    expect(partial.writeCount).toBe(1);
  });
});

describe("interactive append-only lab controls", () => {
  test("creates, renames, reparents, changes permission and content, diffs, and resets", () => {
    const lab = DriveLab.initialize(sandbox(), "messy-paisano");
    const initial = lab.snapshot();
    const edits: LabEdit[] = [
      {
        item: {
          content: "Synthetic added file.",
          id: "operator-added",
          mimeType: "text/plain",
          name: "Operator Added.txt",
          parentIds: ["messy-root"],
        },
        type: "create",
      },
      { itemId: "operator-added", name: "Renamed.txt", type: "rename" },
      {
        itemId: "operator-added",
        parentIds: ["messy-communications"],
        type: "reparent",
      },
      {
        canRead: true,
        canWrite: false,
        itemId: "operator-added",
        type: "permission",
      },
      {
        content: "Synthetic changed content.",
        exportMimeType: "text/plain",
        itemId: "operator-added",
        type: "content",
      },
    ];
    for (const edit of edits) lab.applyEdit(edit);

    const changed = lab.snapshot();
    expect(changed.hash).not.toBe(initial.hash);
    expect(lab.diff(initial.hash)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "operator-added", kind: "ADDED" }),
      ]),
    );
    expect(lab.tree()).toContain("Renamed.txt");
    lab.reset();
    expect(lab.snapshot()).toEqual(initial);
    expect(lab.tree()).not.toContain("operator-added");

    const files = readdirSync(lab.sandboxRoot, { recursive: true });
    expect(files.some((entry) => String(entry).includes("state-"))).toBe(true);
    expect(
      readFileSync(join(lab.sandboxRoot, "lab-ledger.ndjson"), "utf8")
        .trim()
        .split("\n").length,
    ).toBe(edits.length + 2);
  });

  test("applies the shared rename and shortcut mutation contracts", async () => {
    const lab = DriveLab.initialize(sandbox(), "messy-paisano");
    const before = await lab.read.getItem("messy-invoice-draft");
    expect(before.ok && before.value).not.toBeNull();
    if (!before.ok || before.value === null) throw new Error("Missing target.");
    const renamed = await lab.mutation.rename({
      expectedModifiedTime: before.value.modifiedTime,
      name: "2026-08-01 — Hotel Paisano — Invoice.pdf",
      targetId: before.value.id,
    });
    const shortcut = await lab.mutation.createShortcut({
      name: "Invoice shortcut",
      parentId: "messy-communications",
      targetId: before.value.id,
    });
    const repeated = await lab.mutation.createShortcut({
      name: "Invoice shortcut",
      parentId: "messy-communications",
      targetId: before.value.id,
    });

    expect(renamed.ok).toBe(true);
    expect(shortcut.ok).toBe(true);
    expect(repeated).toEqual(shortcut);
    expect(lab.writeCount).toBe(2);
    expect(lab.mutationRequests).toHaveLength(3);
    expect((await listAll(lab)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "2026-08-01 — Hotel Paisano — Invoice.pdf",
        }),
        expect.objectContaining({ shortcutTargetId: "messy-invoice-draft" }),
      ]),
    );
  });

  test("injects deterministic provider failures", async () => {
    const lab = DriveLab.initialize(sandbox(), "clean");
    lab.applyEdit({
      error: {
        code: "RATE_LIMITED",
        itemId: null,
        message: "Synthetic rate limit.",
        retryable: true,
      },
      method: "listItems",
      occurrence: 1,
      type: "fault",
    });
    const request = {
      pageSize: 10,
      pageToken: null,
      rootId: lab.manifest.rootId,
      supportsAllDrives: true,
    } as const;
    const failed = await lab.read.listItems(request);
    const recovered = await lab.read.listItems(request);
    expect(failed).toMatchObject({
      error: { code: "RATE_LIMITED" },
      ok: false,
    });
    expect(recovered.ok).toBe(true);
  });

  test("rejects an indirect folder parent cycle", () => {
    const lab = DriveLab.initialize(sandbox(), "messy-paisano");
    lab.applyEdit({
      item: {
        id: "nested-folder",
        mimeType: "application/vnd.google-apps.folder",
        name: "Nested",
        parentIds: ["messy-communications"],
      },
      type: "create",
    });
    expect(() =>
      lab.applyEdit({
        itemId: "messy-communications",
        parentIds: ["nested-folder"],
        type: "reparent",
      }),
    ).toThrow(/parent/u);
  });
});

describe("sandbox path security", () => {
  test.each(["../escape", "/absolute", "nested/../../escape", "a\0b"])(
    "rejects %s",
    (relativePath) => {
      expect(() => resolveSandboxPath(sandbox(), relativePath)).toThrow(
        DriveLabError,
      );
    },
  );

  test("refuses a symlink sandbox root", () => {
    const parent = sandbox("parent");
    const outside = sandbox("outside");
    mkdirSync(parent, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(parent, "linked-lab");
    symlinkSync(outside, link, "dir");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => DriveLab.initialize(link, "clean")).toThrow(/symlink/u);
  });

  test("refuses an intermediate symlink that resolves outside the sandbox", () => {
    const root = sandbox("root");
    const outside = sandbox("outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "linked"), "dir");
    expect(() => resolveSandboxPath(root, "linked/secret.txt")).toThrow(
      /symlink|outside/u,
    );
  });

  test("exports no delete or destructive move control", () => {
    const lab = DriveLab.initialize(sandbox(), "clean");
    const labMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(lab));
    expect(labMethods).not.toEqual(
      expect.arrayContaining(["delete", "move", "trash", "updateContent"]),
    );
    expect(Object.keys(lab.mutation).sort()).toEqual([
      "capability",
      "createShortcut",
      "rename",
    ]);
    expect(() =>
      lab.applyEdit({ type: "delete" } as unknown as LabEdit),
    ).toThrow(/edit/u);
  });
});
