import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangePlan, ChangePlanSchema } from "@dvw/change-planner";
import { CLI_EXIT_CODES, runCli, type CliRuntime } from "@dvw/cli";
import {
  createActionId,
  type ObservedItem,
  type ProposedAction,
  type ReadProvider,
} from "@dvw/core";
import {
  createInstrumentedFakeDrive,
  type FakeDriveFixture,
} from "@dvw/drive-provider";
import { DriveLab } from "@dvw/drive-simulator";
import {
  createApprovalArtifact,
  dryRunApprovedPlan,
  type ApprovalArtifact,
} from "@dvw/execution";
import { describe, expect, test } from "vitest";

const observedAt = "2026-08-08T12:00:00.000Z";
const approvedAt = "2026-08-08T17:00:00.000Z";
const checkedAt = "2026-08-08T17:30:00.000Z";
const scanGeneration = "scan-preflight-1";
const policyVersion = "1.0.0";
const folderMimeType = "application/vnd.google-apps.folder";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function item(
  id: string,
  name: string,
  input: Partial<ObservedItem> = {},
): ObservedItem {
  return {
    contentFingerprint: null,
    createdTime: "2026-08-01T00:00:00.000Z",
    id,
    mimeType: "application/pdf",
    modifiedTime: observedAt,
    name,
    parentIds: ["root"],
    permissions: { canRead: true, canWrite: true },
    scanGeneration,
    shortcutTargetId: null,
    trashed: false,
    ...input,
  };
}

const root = item("root", "Drive root", {
  mimeType: folderMimeType,
  parentIds: [],
});
const destination = item("organized", "Organized", {
  mimeType: folderMimeType,
});
const invoice = item("invoice-1", "Invoice draft.pdf");
const source = item("contract-1", "Hotel Paisano Contract.pdf");

function itemPreconditions(target: ObservedItem) {
  return {
    modifiedTime: target.modifiedTime,
    name: target.name,
    parentIds: [...target.parentIds].sort(),
    permissions: {
      canRead: target.permissions.canRead,
      canWrite: target.permissions.canWrite,
    },
    shortcutTargetId: target.shortcutTargetId,
    trashed: target.trashed,
  };
}

function action(
  target: ObservedItem,
  type: "RENAME" | "CREATE_SHORTCUT",
  desiredState: ProposedAction["desiredState"],
  preconditions: ProposedAction["preconditions"],
  reasonCode: string,
): ProposedAction {
  return {
    actionId: createActionId({
      desiredState,
      planIdentity: `${scanGeneration}\u0000${policyVersion}`,
      targetId: target.id,
      type,
    }),
    confidence: 0.95,
    desiredState,
    evidenceIds: [`fact-${target.id}`],
    policyVersion,
    preconditions,
    reasonCode,
    reviewState: "Pending",
    scanGeneration,
    targetId: target.id,
    type,
  };
}

function plan(input: { readonly renameName?: string } = {}): ChangePlan {
  const renameName =
    input.renameName ?? "2026-08-01 - Hotel Paisano - Invoice.pdf";
  const actions = [
    action(
      invoice,
      "RENAME",
      { name: renameName },
      itemPreconditions(invoice),
      "PAISANO.NAME.DEAL_DOCUMENT",
    ),
    action(
      source,
      "CREATE_SHORTCUT",
      { name: "2026 - Hotel Paisano - Contract", parentId: destination.id },
      {
        destination: { id: destination.id, ...itemPreconditions(destination) },
        existingShortcutIds: [],
        source: itemPreconditions(source),
      },
      "PAISANO.SHORTCUT.DEAL_DOCUMENT",
    ),
  ];
  return changePlan(actions);
}

function changePlan(actions: readonly ProposedAction[]): ChangePlan {
  const authorization = {
    actions: actions.map((entry) => ({
      actionId: entry.actionId,
      desiredState: entry.desiredState,
      evidenceIds: entry.evidenceIds,
      policyVersion: entry.policyVersion,
      preconditions: entry.preconditions,
      reasonCode: entry.reasonCode,
      scanGeneration: entry.scanGeneration,
      targetId: entry.targetId,
      type: entry.type,
    })),
    policyVersion,
    scanGeneration,
    schemaVersion: "dvw.change-plan.v1",
  };
  const canonicalJson = stableJson(authorization);
  return ChangePlanSchema.parse({
    actions,
    approvalEligible: true,
    blockers: [],
    canonicalJson,
    effectiveActions: actions,
    explanations: actions.map((entry) => ({
      actionId: entry.actionId,
      summary: `Execute ${entry.type} for ${entry.targetId}.`,
      writeRequired: true,
    })),
    hashContract: "dvw.change-plan.v1",
    planHash: createHash("sha256").update(canonicalJson).digest("hex"),
    policyVersion,
    scanGeneration,
  });
}

async function requiredItem(provider: ReadProvider, itemId: string) {
  const result = await provider.getItem(itemId);
  if (!result.ok || result.value === null) {
    throw new Error(`Missing test item ${itemId}.`);
  }
  return result.value;
}

function approve(inputPlan: ChangePlan): ApprovalArtifact {
  return createApprovalArtifact(inputPlan, {
    approvedAt,
    approver: "Buck operator",
    confirmation: `APPROVE ${inputPlan.planHash}`,
    expiresAt: "2026-08-08T18:00:00.000Z",
  });
}

function fixture(items: readonly ObservedItem[]): FakeDriveFixture {
  return {
    items: items.map((entry) => ({ item: entry })),
    rootIds: [root.id],
  };
}

describe("whole-plan preflight and zero-write dry-run", () => {
  test("prints the exact ordered rename and shortcut operations with zero mutations", async () => {
    const inputPlan = plan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
    );

    const result = await dryRunApprovedPlan({
      approval: approve(inputPlan),
      checkedAt,
      plan: inputPlan,
      provider: drive.read,
    });

    expect(result).toMatchSnapshot();
    expect(result.status).toBe("Ready");
    expect(result.operations.map((entry) => entry.type)).toEqual([
      "RENAME",
      "CREATE_SHORTCUT",
    ]);
    expect(result.operations.map((entry) => entry.disposition)).toEqual([
      "Write",
      "Write",
    ]);
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("blocks the whole plan when a target changed after approval", async () => {
    const inputPlan = plan();
    const drive = createInstrumentedFakeDrive(
      fixture([
        root,
        destination,
        { ...invoice, modifiedTime: "2026-08-08T17:05:00.000Z" },
        source,
      ]),
    );

    const result = await dryRunApprovedPlan({
      approval: approve(inputPlan),
      checkedAt,
      plan: inputPlan,
      provider: drive.read,
    });

    expect(result.status).toBe("Blocked");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: inputPlan.actions[0]!.actionId,
          code: "STALE_MODIFIED_TIME",
          itemId: invoice.id,
        }),
      ]),
    );
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("blocks a name collision that appeared after planning", async () => {
    const inputPlan = plan();
    const collision = item(
      "collision-1",
      "2026-08-01 - HOTEL PAISANO - Invoice.pdf",
    );
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source, collision]),
    );

    const result = await dryRunApprovedPlan({
      approval: approve(inputPlan),
      checkedAt,
      plan: inputPlan,
      provider: drive.read,
    });

    expect(result.status).toBe("Blocked");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "NAME_COLLISION",
          itemId: collision.id,
        }),
      ]),
    );
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("shows an already-satisfied rename as a no-op candidate", async () => {
    const inputPlan = plan();
    const desiredName = inputPlan.actions[0]!.desiredState.name;
    if (typeof desiredName !== "string") throw new TypeError("Missing name.");
    const drive = createInstrumentedFakeDrive(
      fixture([
        root,
        destination,
        {
          ...invoice,
          modifiedTime: "2026-08-08T17:05:00.000Z",
          name: desiredName,
        },
        source,
      ]),
    );

    const result = await dryRunApprovedPlan({
      approval: approve(inputPlan),
      checkedAt,
      plan: inputPlan,
      provider: drive.read,
    });

    expect(result.status).toBe("Ready");
    expect(result.operations[0]).toMatchObject({
      actionId: inputPlan.actions[0]!.actionId,
      disposition: "NoOp",
      reason: `Target ${invoice.id} already has the approved name ${desiredName}.`,
      request: null,
      type: "RENAME",
    });
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("rejects an old approval before reads when feedback changes the plan hash", async () => {
    const oldPlan = plan();
    const replanned = plan({
      renameName: "2026-08-02 - Hotel Paisano - Invoice.pdf",
    });
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
    );

    await expect(
      dryRunApprovedPlan({
        approval: approve(oldPlan),
        checkedAt,
        plan: replanned,
        provider: drive.read,
      }),
    ).rejects.toThrow(/planHash|does not match/u);
    expect(drive.calls).toEqual([]);
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("blocks missing, parent-changed, and permission-changed targets without writes", async () => {
    const inputPlan = plan();
    const cases: Array<{
      code: string;
      items: ObservedItem[];
      label: string;
    }> = [
      {
        code: "ITEM_MISSING",
        items: [root, destination, source],
        label: "missing",
      },
      {
        code: "STALE_PARENTS",
        items: [
          root,
          destination,
          { ...invoice, parentIds: [destination.id] },
          source,
        ],
        label: "parent-changed",
      },
      {
        code: "STALE_PERMISSIONS",
        items: [
          root,
          destination,
          {
            ...invoice,
            permissions: { canRead: true, canWrite: false },
          },
          source,
        ],
        label: "permission-changed",
      },
    ];
    for (const inputCase of cases) {
      const drive = createInstrumentedFakeDrive(fixture(inputCase.items));
      const result = await dryRunApprovedPlan({
        approval: approve(inputPlan),
        checkedAt,
        plan: inputPlan,
        provider: drive.read,
      });
      expect(result.status, inputCase.label).toBe("Blocked");
      expect(
        result.issues.map((entry) => entry.code),
        inputCase.label,
      ).toContain(inputCase.code);
      expect(drive.writeCount, inputCase.label).toBe(0);
      expect(drive.mutationRequests, inputCase.label).toEqual([]);
    }
  });

  test("recognizes an exact live shortcut as a no-op", async () => {
    const inputPlan = plan();
    const exactShortcut = item(
      "shortcut-existing",
      "2026 - Hotel Paisano - Contract",
      {
        mimeType: "application/vnd.google-apps.shortcut",
        parentIds: [destination.id],
        shortcutTargetId: source.id,
      },
    );
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source, exactShortcut]),
    );

    const result = await dryRunApprovedPlan({
      approval: approve(inputPlan),
      checkedAt,
      plan: inputPlan,
      provider: drive.read,
    });

    expect(result.status).toBe("Ready");
    expect(result.operations[1]).toMatchObject({
      disposition: "NoOp",
      request: null,
      targetId: source.id,
      type: "CREATE_SHORTCUT",
    });
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("consumes every collision page and blocks a later-page collision", async () => {
    const inputPlan = plan();
    const filler = Array.from({ length: 101 }, (_, index) =>
      item(`filler-${String(index).padStart(3, "0")}`, `Filler ${index}.pdf`),
    );
    const collision = item(
      "later-page-collision",
      "2026-08-01 - hotel paisano - invoice.pdf",
    );
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source, ...filler, collision]),
    );

    const result = await dryRunApprovedPlan({
      approval: approve(inputPlan),
      checkedAt,
      plan: inputPlan,
      provider: drive.read,
    });

    expect(result.status).toBe("Blocked");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "NAME_COLLISION",
          itemId: collision.id,
        }),
      ]),
    );
    expect(
      drive.calls.filter(
        (entry) =>
          entry.method === "listItems" &&
          (entry.request as { rootId?: string }).rootId === root.id,
      ),
    ).toHaveLength(2);
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("returns a provider failure as a whole-plan block with zero mutations", async () => {
    const inputPlan = plan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
    );
    drive.controls.failOnCall("getItem", 1, {
      code: "RATE_LIMITED",
      itemId: source.id,
      message: "Synthetic read quota window.",
      retryable: true,
    });

    const result = await dryRunApprovedPlan({
      approval: approve(inputPlan),
      checkedAt,
      plan: inputPlan,
      provider: drive.read,
    });

    expect(result.status).toBe("Blocked");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVIDER_ERROR" }),
      ]),
    );
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("does not treat a nested Drive Lab shortcut as a direct-parent collision", async () => {
    const labRoot = mkdtempSync(join(tmpdir(), "dvw-preflight-lab-scope-"));
    const lab = DriveLab.initialize(labRoot, "messy-paisano");
    const boardMemo = await requiredItem(lab.read, "messy-board-memo");
    const labDestination = await requiredItem(lab.read, "messy-root");
    const existingShortcut = await requiredItem(
      lab.read,
      "messy-existing-shortcut",
    );
    const shortcutAction = action(
      boardMemo,
      "CREATE_SHORTCUT",
      {
        name: "2026 - Hotel Paisano - Board Memo",
        parentId: labDestination.id,
      },
      {
        destination: {
          id: labDestination.id,
          ...itemPreconditions(labDestination),
        },
        existingShortcutIds: [existingShortcut.id],
        source: itemPreconditions(boardMemo),
      },
      "PAISANO.SHORTCUT.DEAL_DOCUMENT",
    );
    const inputPlan = changePlan([shortcutAction]);

    const result = await dryRunApprovedPlan({
      approval: approve(inputPlan),
      checkedAt,
      plan: inputPlan,
      provider: lab.read,
    });

    expect(result.status).toBe("Ready");
    expect(result.issues).toEqual([]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        disposition: "Write",
        targetId: boardMemo.id,
        type: "CREATE_SHORTCUT",
      }),
    ]);
    expect(lab.writeCount).toBe(0);
    expect(lab.mutationRequests).toEqual([]);
  });
});

describe("operator-only approval and dry-run CLI", () => {
  test("creates one immutable approval file and reports the same zero-write operation list", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dvw-preflight-cli-"));
    const inputPlan = plan();
    const planPath = join(temporaryRoot, "plan.json");
    writeFileSync(planPath, `${JSON.stringify(inputPlan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
    );
    const runtime: CliRuntime = {
      artifactsRoot: join(temporaryRoot, "unused-artifacts"),
      databasePath: join(temporaryRoot, "unused.sqlite"),
      defaultProviderId: "fake",
      generationId: () => {
        throw new Error("Approval cannot create scan generations.");
      },
      now: () => approvedAt,
      planning: {
        build: () => {
          throw new Error("Approval cannot call the planner.");
        },
      },
      policyVersion,
      providers: {
        select: ({ providerId }) => {
          if (providerId !== "fake") throw new Error("Unknown provider.");
          return Promise.resolve({ providerId, read: drive.read });
        },
      },
    };
    const approvalDirectory = join(temporaryRoot, "approvals");

    const approved = await runCli(
      [
        "approve",
        "--plan",
        planPath,
        "--approver",
        "Buck operator",
        "--confirm",
        `APPROVE ${inputPlan.planHash}`,
        "--expires-at",
        "2026-08-08T18:00:00.000Z",
        "--output-dir",
        approvalDirectory,
        "--json",
      ],
      runtime,
    );

    expect(approved.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(approved.output).toMatchObject({
      command: "approve",
      data: {
        planHash: inputPlan.planHash,
      },
      status: "SUCCESS",
    });
    if (approved.output.command !== "approve") {
      throw new TypeError("Approve returned the wrong output contract.");
    }
    const approvalPath = approved.output.data.artifactPath;
    expect(readFileSync(approvalPath, "utf8")).toContain(inputPlan.planHash);

    const dryRun = await runCli(
      [
        "dry-run",
        "--plan",
        planPath,
        "--approval",
        approvalPath,
        "--provider",
        "fake",
        "--json",
      ],
      runtime,
    );

    expect(dryRun.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(dryRun.output).toMatchObject({
      command: "dry-run",
      data: {
        operationCount: 2,
        providerId: "fake",
        writeCount: 0,
      },
      status: "SUCCESS",
    });
    if (dryRun.output.command !== "dry-run") {
      throw new TypeError("Dry-run returned the wrong output contract.");
    }
    expect(dryRun.output.data.operations.map((entry) => entry.type)).toEqual([
      "RENAME",
      "CREATE_SHORTCUT",
    ]);
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });
});
