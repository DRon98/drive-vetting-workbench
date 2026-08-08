import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangePlanSchema, type ChangePlan } from "@dvw/change-planner";
import { CLI_EXIT_CODES, runCli, type CliRuntime } from "@dvw/cli";
import {
  createActionId,
  type ActionType,
  type MutationProvider,
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
  executeApprovedPlan,
  serializeApprovalArtifact,
} from "@dvw/execution";
import { describe, expect, test } from "vitest";

const observedAt = "2026-08-08T12:00:00.000Z";
const checkedAt = "2026-08-08T17:30:00.000Z";
const scanGeneration = "scan-execution-1";
const policyVersion = "1.0.0";
const folderMimeType = "application/vnd.google-apps.folder";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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

function action(input: {
  readonly desiredState: ProposedAction["desiredState"];
  readonly preconditions: ProposedAction["preconditions"];
  readonly reasonCode: string;
  readonly target: ObservedItem;
  readonly type: ActionType;
}): ProposedAction {
  return {
    actionId: createActionId({
      desiredState: input.desiredState,
      planIdentity: `${scanGeneration}\u0000${policyVersion}`,
      targetId: input.target.id,
      type: input.type,
    }),
    confidence: 0.95,
    desiredState: input.desiredState,
    evidenceIds: [`fact-${input.target.id}`],
    policyVersion,
    preconditions: input.preconditions,
    reasonCode: input.reasonCode,
    reviewState: "Pending",
    scanGeneration,
    targetId: input.target.id,
    type: input.type,
  };
}

function plan(actions: readonly ProposedAction[]): ChangePlan {
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
  const effectiveActions = actions.filter(
    (entry) => entry.type === "RENAME" || entry.type === "CREATE_SHORTCUT",
  );
  return ChangePlanSchema.parse({
    actions,
    approvalEligible: true,
    blockers: [],
    canonicalJson,
    effectiveActions,
    explanations: actions.map((entry) => ({
      actionId: entry.actionId,
      summary: `Execute ${entry.type} for ${entry.targetId}.`,
      writeRequired:
        entry.type === "RENAME" || entry.type === "CREATE_SHORTCUT",
    })),
    hashContract: "dvw.change-plan.v1",
    planHash: createHash("sha256").update(canonicalJson).digest("hex"),
    policyVersion,
    scanGeneration,
  });
}

function approval(inputPlan: ChangePlan) {
  return createApprovalArtifact(inputPlan, {
    approvedAt: "2026-08-08T17:00:00.000Z",
    approver: "Buck operator",
    confirmation: `APPROVE ${inputPlan.planHash}`,
    expiresAt: "2026-08-08T18:00:00.000Z",
  });
}

function getItem(provider: ReadProvider, itemId: string) {
  return provider.getItem(itemId).then((result) => {
    if (!result.ok || result.value === null) {
      throw new Error(`Missing fixture item ${itemId}.`);
    }
    return result.value;
  });
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

function writePlan(
  input: {
    readonly destination?: ObservedItem;
    readonly invoice?: ObservedItem;
    readonly source?: ObservedItem;
  } = {},
): ChangePlan {
  const renameTarget = input.invoice ?? invoice;
  const shortcutSource = input.source ?? source;
  const shortcutDestination = input.destination ?? destination;
  return plan([
    action({
      desiredState: { name: "2026-08-01 - Hotel Paisano - Invoice.pdf" },
      preconditions: itemPreconditions(renameTarget),
      reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
      target: renameTarget,
      type: "RENAME",
    }),
    action({
      desiredState: {
        name: "2026 - Hotel Paisano - Contract",
        parentId: shortcutDestination.id,
      },
      preconditions: {
        destination: {
          id: shortcutDestination.id,
          ...itemPreconditions(shortcutDestination),
        },
        existingShortcutIds: [],
        source: itemPreconditions(shortcutSource),
      },
      reasonCode: "PAISANO.SHORTCUT.DEAL_DOCUMENT",
      target: shortcutSource,
      type: "CREATE_SHORTCUT",
    }),
  ]);
}

function fixture(items: readonly ObservedItem[]): FakeDriveFixture {
  return {
    items: items.map((entry) => ({ item: entry })),
    rootIds: [root.id],
  };
}

describe("deterministic approved executor", () => {
  test("preflights the whole plan, re-fetches stable IDs, and calls only ordered approved mutations", async () => {
    const inputPlan = writePlan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
      { now: () => "2026-08-08T17:31:00.000Z" },
    );

    const result = await executeApprovedPlan({
      approval: approval(inputPlan),
      checkedAt,
      mutationProvider: drive.mutation,
      plan: inputPlan,
      readProvider: drive.read,
    });

    expect(result).toMatchSnapshot();
    expect(result.state, JSON.stringify(result, null, 2)).toBe(
      "PendingVerification",
    );
    expect(result.results.map((entry) => entry.disposition)).toEqual([
      "MutationAccepted",
      "MutationAccepted",
    ]);
    expect(drive.mutationRequests.map((entry) => entry.method)).toEqual([
      "rename",
      "createShortcut",
    ]);
    expect(drive.calls.map((entry) => entry.method)).toEqual([
      "getItem",
      "getItem",
      "getItem",
      "listItems",
      "listItems",
      "getItem",
      "rename",
      "getItem",
      "getItem",
      "listItems",
      "createShortcut",
    ]);
    expect(drive.writeCount).toBe(2);
  });

  test("performs zero writes when whole-plan preflight rejects stale state", async () => {
    const inputPlan = writePlan();
    const drive = createInstrumentedFakeDrive(
      fixture([
        root,
        destination,
        { ...invoice, modifiedTime: "2026-08-08T17:05:00.000Z" },
        source,
      ]),
    );

    const result = await executeApprovedPlan({
      approval: approval(inputPlan),
      checkedAt,
      mutationProvider: drive.mutation,
      plan: inputPlan,
      readProvider: drive.read,
    });

    expect(result.state).toBe("Rejected");
    expect(result.results).toEqual([]);
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("stops after a provider failure and marks a prior accepted write partial", async () => {
    const inputPlan = writePlan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
    );
    drive.controls.failOnCall("createShortcut", 1, {
      code: "PROVIDER_FAILURE",
      itemId: source.id,
      message: "Synthetic apply interruption.",
      retryable: true,
    });

    const result = await executeApprovedPlan({
      approval: approval(inputPlan),
      checkedAt,
      mutationProvider: drive.mutation,
      plan: inputPlan,
      readProvider: drive.read,
    });

    expect(result.state).toBe("Partial");
    expect(result.results.map((entry) => entry.disposition)).toEqual([
      "MutationAccepted",
      "Failed",
    ]);
    expect(result.stoppedAtActionId).toBe(inputPlan.actions[1]!.actionId);
    expect(drive.writeCount).toBe(1);
    expect(drive.mutationRequests.map((entry) => entry.method)).toEqual([
      "rename",
      "createShortcut",
    ]);
  });

  test("stops after an unexpected provider result and does not start a later write", async () => {
    const inputPlan = writePlan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
    );
    const mismatchedMutation: MutationProvider = {
      capability: "mutation",
      createShortcut: (request) => drive.mutation.createShortcut(request),
      rename: async (request) => {
        const result = await drive.mutation.rename(request);
        return result.ok
          ? {
              ok: true,
              value: { ...result.value, parentIds: ["unexpected-parent"] },
            }
          : result;
      },
    };

    const result = await executeApprovedPlan({
      approval: approval(inputPlan),
      checkedAt,
      mutationProvider: mismatchedMutation,
      plan: inputPlan,
      readProvider: drive.read,
    });

    expect(result).toMatchObject({
      acceptedMutationCount: 0,
      mutationCallCount: 1,
      state: "Partial",
      stoppedAtActionId: inputPlan.actions[0]!.actionId,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.disposition).toBe("Failed");
    expect(result.results[0]?.failure?.code).toBe("UNEXPECTED_PROVIDER_RESULT");
    expect(result.results[0]?.mutationCalled).toBe(true);
    expect(drive.writeCount).toBe(1);
    expect(drive.mutationRequests.map((entry) => entry.method)).toEqual([
      "rename",
    ]);
  });

  test("does not count an immediate read failure as a mutation call", async () => {
    const inputPlan = writePlan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
    );
    drive.controls.failOnCall("getItem", 4, {
      code: "RATE_LIMITED",
      itemId: invoice.id,
      message: "Synthetic immediate re-fetch failure.",
      retryable: true,
    });

    const result = await executeApprovedPlan({
      approval: approval(inputPlan),
      checkedAt,
      mutationProvider: drive.mutation,
      plan: inputPlan,
      readProvider: drive.read,
    });

    expect(result.state).toBe("Failed");
    expect(result.mutationCallCount).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.disposition).toBe("Failed");
    expect(result.results[0]?.failure?.code).toBe("PROVIDER_ERROR");
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("does not duplicate an exact shortcut and never mutates non-write actions", async () => {
    const exactShortcut = item(
      "shortcut-existing",
      "2026 - Hotel Paisano - Contract",
      {
        mimeType: "application/vnd.google-apps.shortcut",
        parentIds: [destination.id],
        shortcutTargetId: source.id,
      },
    );
    const inputPlan = writePlan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source, exactShortcut]),
    );

    const result = await executeApprovedPlan({
      approval: approval(inputPlan),
      checkedAt,
      mutationProvider: drive.mutation,
      plan: inputPlan,
      readProvider: drive.read,
    });

    expect(result.results[1]).toMatchObject({
      disposition: "NoOp",
      verification: "Pending",
    });
    expect(drive.mutationRequests.map((entry) => entry.method)).toEqual([
      "rename",
    ]);

    for (const type of ["KEEP", "PRESERVE_ARCHIVE"] as const) {
      const nonWritePlan = plan([
        action({
          desiredState:
            type === "KEEP"
              ? { name: source.name, parentIds: source.parentIds }
              : { parentIds: source.parentIds },
          preconditions: itemPreconditions(source),
          reasonCode:
            type === "KEEP"
              ? "PAISANO.KEEP.CURRENT"
              : "PAISANO.ARCHIVE.PRESERVE",
          target: source,
          type,
        }),
      ]);
      const nonWriteDrive = createInstrumentedFakeDrive(
        fixture([root, source]),
      );
      const result = await executeApprovedPlan({
        approval: approval(nonWritePlan),
        checkedAt,
        mutationProvider: nonWriteDrive.mutation,
        plan: nonWritePlan,
        readProvider: nonWriteDrive.read,
      });
      expect(result.state).toBe("NoOp");
      expect(nonWriteDrive.writeCount).toBe(0);
      expect(nonWriteDrive.mutationRequests).toEqual([]);
    }
  });

  test("does not substitute a similar name when the approved stable ID is missing", async () => {
    const inputPlan = writePlan();
    const impostor = item("invoice-impostor", invoice.name);
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, impostor, source]),
    );

    const result = await executeApprovedPlan({
      approval: approval(inputPlan),
      checkedAt,
      mutationProvider: drive.mutation,
      plan: inputPlan,
      readProvider: drive.read,
    });

    expect(result.state).toBe("Rejected");
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toEqual([]);
  });

  test("uses the same executor path with Drive Lab without provider-name branching", async () => {
    const labRoot = mkdtempSync(join(tmpdir(), "dvw-execution-lab-"));
    const lab = DriveLab.initialize(labRoot, "messy-paisano");
    const labInvoice = await getItem(lab.read, "messy-invoice-draft");
    const boardMemo = await getItem(lab.read, "messy-board-memo");
    const labDestination = await getItem(lab.read, "messy-root");
    const existingShortcut = await getItem(lab.read, "messy-existing-shortcut");
    const inputPlan = plan([
      action({
        desiredState: { name: "2026-08-01 - Hotel Paisano - Invoice.pdf" },
        preconditions: itemPreconditions(labInvoice),
        reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
        target: labInvoice,
        type: "RENAME",
      }),
      action({
        desiredState: {
          name: "2026 - Hotel Paisano - Board Memo",
          parentId: labDestination.id,
        },
        preconditions: {
          destination: {
            id: labDestination.id,
            ...itemPreconditions(labDestination),
          },
          existingShortcutIds: [existingShortcut.id],
          source: itemPreconditions(boardMemo),
        },
        reasonCode: "PAISANO.SHORTCUT.DEAL_DOCUMENT",
        target: boardMemo,
        type: "CREATE_SHORTCUT",
      }),
    ]);

    const result = await executeApprovedPlan({
      approval: approval(inputPlan),
      checkedAt,
      mutationProvider: lab.mutation,
      plan: inputPlan,
      readProvider: lab.read,
    });

    expect(result.state, JSON.stringify(result, null, 2)).toBe(
      "PendingVerification",
    );
    expect(lab.mutationRequests.map((entry) => entry.method)).toEqual([
      "rename",
      "createShortcut",
    ]);
    expect(lab.writeCount).toBe(2);
  });
});

describe("operator-only apply CLI", () => {
  test("requires explicit apply confirmation and selects a distinct execution provider", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dvw-apply-cli-"));
    const inputPlan = writePlan();
    const inputApproval = approval(inputPlan);
    const planPath = join(temporaryRoot, "plan.json");
    const approvalPath = join(temporaryRoot, "approval.json");
    writeFileSync(planPath, `${JSON.stringify(inputPlan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(approvalPath, serializeApprovalArtifact(inputApproval), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
      { now: () => "2026-08-08T17:31:00.000Z" },
    );
    let executionSelections = 0;
    const runtime: CliRuntime = {
      artifactsRoot: join(temporaryRoot, "unused-artifacts"),
      databasePath: join(temporaryRoot, "unused.sqlite"),
      defaultProviderId: "fake",
      executionProviders: {
        select: ({ providerId }) => {
          executionSelections += 1;
          return Promise.resolve({
            mutation: drive.mutation,
            providerId,
            read: drive.read,
          });
        },
      },
      generationId: () => {
        throw new Error("Apply cannot create scan generations.");
      },
      now: () => checkedAt,
      planning: {
        build: () => {
          throw new Error("Apply cannot call the planner.");
        },
      },
      policyVersion,
      providers: {
        select: () => {
          throw new Error("Apply must not use the read-only selector.");
        },
      },
    };

    const unresolvedPlan = plan([
      action({
        desiredState: {},
        preconditions: itemPreconditions(source),
        reasonCode: "PAISANO.REVIEW.MATERIAL_QUESTION",
        target: source,
        type: "NEEDS_REVIEW",
      }),
    ]);
    const unresolvedPlanPath = join(temporaryRoot, "unresolved-plan.json");
    writeFileSync(
      unresolvedPlanPath,
      `${JSON.stringify(unresolvedPlan, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    const unresolved = await runCli(
      [
        "apply",
        "--plan",
        unresolvedPlanPath,
        "--approval",
        approvalPath,
        "--confirm",
        `APPLY ${unresolvedPlan.planHash}`,
      ],
      runtime,
    );
    expect(unresolved.exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
    expect(executionSelections).toBe(0);
    expect(drive.writeCount).toBe(0);

    const denied = await runCli(
      [
        "apply",
        "--plan",
        planPath,
        "--approval",
        approvalPath,
        "--confirm",
        "Apply",
      ],
      runtime,
    );
    expect(denied.exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
    expect(executionSelections).toBe(0);
    expect(drive.writeCount).toBe(0);

    const applied = await runCli(
      [
        "apply",
        "--plan",
        planPath,
        "--approval",
        approvalPath,
        "--provider",
        "fake",
        "--confirm",
        `APPLY ${inputPlan.planHash}`,
        "--json",
      ],
      runtime,
    );

    expect(applied.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(applied.output).toMatchObject({
      command: "apply",
      data: {
        acceptedMutationCount: 2,
        mutationCallCount: 2,
        planHash: inputPlan.planHash,
        providerId: "fake",
        receiptCount: 2,
        state: "Completed",
      },
      status: "SUCCESS",
    });
    expect(executionSelections).toBe(1);
    expect(drive.writeCount).toBe(2);
    expect(drive.mutationRequests.map((entry) => entry.method)).toEqual([
      "rename",
      "createShortcut",
    ]);
  });
});
