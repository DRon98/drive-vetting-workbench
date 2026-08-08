import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import {
  applyApprovedPlan,
  createApprovalArtifact,
  ExecutionLedger,
} from "@dvw/execution";
import { describe, expect, test } from "vitest";

const observedAt = "2026-08-08T12:00:00.000Z";
const checkedAt = "2026-08-08T17:30:00.000Z";
const policyVersion = "1.0.0";
const scanGeneration = "scan-resume-1";
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

const root = item("root", "Drive root", {
  mimeType: folderMimeType,
  parentIds: [],
});
const destination = item("organized", "Organized", {
  mimeType: folderMimeType,
});
const invoice = item("invoice-1", "Invoice draft.pdf");
const source = item("contract-1", "Hotel Paisano Contract.pdf");
const desiredInvoiceName = "2026-08-01 - Hotel Paisano - Invoice.pdf";
const desiredShortcutName = "2026 - Hotel Paisano - Contract";

function inputPlan(): ChangePlan {
  return plan([
    action({
      desiredState: { name: desiredInvoiceName },
      preconditions: itemPreconditions(invoice),
      reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
      target: invoice,
      type: "RENAME",
    }),
    action({
      desiredState: {
        name: desiredShortcutName,
        parentId: destination.id,
      },
      preconditions: {
        destination: {
          id: destination.id,
          ...itemPreconditions(destination),
        },
        existingShortcutIds: [],
        source: itemPreconditions(source),
      },
      reasonCode: "PAISANO.SHORTCUT.DEAL_DOCUMENT",
      target: source,
      type: "CREATE_SHORTCUT",
    }),
  ]);
}

function approval(input: ChangePlan) {
  return createApprovalArtifact(input, {
    approvedAt: "2026-08-08T17:00:00.000Z",
    approver: "Fixture operator",
    confirmation: `APPROVE ${input.planHash}`,
    expiresAt: "2026-08-08T18:00:00.000Z",
  });
}

function fixture(items: readonly ObservedItem[]): FakeDriveFixture {
  return {
    items: items.map((entry) => ({ item: entry })),
    rootIds: [root.id],
  };
}

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "dvw-resume-")), "workbench.sqlite");
}

function ledgerAt(path: string): ExecutionLedger {
  const store = new EvidenceStore(path);
  store.migrate();
  store.close();
  return new ExecutionLedger(path);
}

async function requiredItem(
  provider: ReadProvider,
  itemId: string,
): Promise<ObservedItem> {
  const result = await provider.getItem(itemId);
  if (!result.ok || result.value === null) {
    throw new Error(`Missing fixture item ${itemId}.`);
  }
  return result.value;
}

describe("verified append-only execution and resume", () => {
  test("retains a partial ledger, resumes without repeating verified work, and makes a third apply zero-write", async () => {
    const input = inputPlan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
      { now: () => "2026-08-08T17:31:00.000Z" },
    );
    drive.controls.failOnCall("createShortcut", 1, {
      code: "PROVIDER_FAILURE",
      itemId: source.id,
      message:
        "Synthetic interruption with refresh_token=fixture-secret and private-body-marker.",
      retryable: true,
    });
    const ledgerPath = databasePath();
    const ledger = ledgerAt(ledgerPath);

    const first = await applyApprovedPlan({
      approval: approval(input),
      checkedAt,
      ledger,
      mutationProvider: drive.mutation,
      now: () => "2026-08-08T17:32:00.000Z",
      plan: input,
      providerId: "fake",
      readProvider: drive.read,
    });

    expect(first).toMatchObject({
      mutationCallCount: 2,
      resumeCursor: 1,
      state: "Partial",
    });
    expect(
      ledger.listRunEvents(first.runId).map((entry) => entry.state),
    ).toEqual(["Started", "Running", "Running", "Partial"]);
    expect(
      ledger.listReceipts(first.runId).map((entry) => entry.verificationStatus),
    ).toEqual(["Verified", "Failed"]);

    const second = await applyApprovedPlan({
      approval: approval(input),
      checkedAt,
      ledger,
      mutationProvider: drive.mutation,
      now: () => "2026-08-08T17:33:00.000Z",
      plan: input,
      providerId: "fake",
      readProvider: drive.read,
    });

    expect(second).toMatchObject({
      mutationCallCount: 1,
      resumeCursor: 2,
      state: "Completed",
    });
    const secondReceipts = ledger.listReceipts(second.runId);
    expect(
      secondReceipts.map((entry) => [
        entry.disposition,
        entry.verificationStatus,
      ]),
    ).toEqual([
      ["NoOp", "Verified"],
      ["MutationAccepted", "Verified"],
    ]);
    expect(
      secondReceipts.every(
        (entry) =>
          entry.beforeSummary !== null &&
          entry.afterSummary !== null &&
          entry.requestSummary !== null,
      ),
    ).toBe(true);
    expect(drive.writeCount).toBe(2);

    expect(() =>
      ledger.appendEvent({
        actionId: null,
        detail: {},
        eventType: "RunFailed",
        occurredAt: "2026-08-08T17:33:10.000Z",
        runId: second.runId,
        state: "Failed",
      }),
    ).toThrow(/Cannot append|Completed/u);
    expect(() =>
      ledger.appendReceipt(second.runId, {
        actionIndex: 0,
        after: null,
        observedItemId: null,
        recordedAt: "2026-08-08T17:33:11.000Z",
        result: second.results[0]!,
      }),
    ).toThrow(/Cannot append a receipt while the run is Completed/u);
    const directDatabase = new DatabaseSync(ledgerPath);
    expect(() =>
      directDatabase
        .prepare(
          "UPDATE execution_receipts SET failure_code = 'tampered' WHERE run_id = ?",
        )
        .run(second.runId),
    ).toThrow(/immutable/u);
    directDatabase.close();

    const planPath = join(
      mkdtempSync(join(tmpdir(), "dvw-verify-cli-")),
      "plan.json",
    );
    writeFileSync(planPath, `${JSON.stringify(input, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const verifyRuntime: CliRuntime = {
      artifactsRoot: join(tmpdir(), "unused-artifacts"),
      databasePath: ledgerPath,
      defaultProviderId: "fake",
      generationId: () => {
        throw new Error("Verify cannot create scan generations.");
      },
      now: () => "2026-08-08T17:33:30.000Z",
      planning: {
        build: () => {
          throw new Error("Verify cannot call the planner.");
        },
      },
      policyVersion,
      providers: {
        select: ({ providerId }) =>
          Promise.resolve({ providerId, read: drive.read }),
      },
    };
    const verified = await runCli(
      [
        "verify",
        "--plan",
        planPath,
        "--run",
        second.runId,
        "--provider",
        "fake",
        "--json",
      ],
      verifyRuntime,
    );
    expect(verified.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(verified.output).toMatchObject({
      command: "verify",
      data: {
        failedActionCount: 0,
        receiptCount: 2,
        runId: second.runId,
        state: "Completed",
        verifiedActionCount: 2,
      },
      status: "SUCCESS",
    });
    expect(drive.writeCount).toBe(2);

    const third = await applyApprovedPlan({
      approval: approval(input),
      checkedAt,
      ledger,
      mutationProvider: drive.mutation,
      now: () => "2026-08-08T17:34:00.000Z",
      plan: input,
      providerId: "fake",
      readProvider: drive.read,
    });

    expect(third).toMatchObject({
      mutationCallCount: 0,
      resumeCursor: 2,
      state: "Completed",
    });
    expect(drive.writeCount).toBe(2);
    expect(drive.mutationRequests.map((entry) => entry.method)).toEqual([
      "rename",
      "createShortcut",
      "createShortcut",
    ]);
    const callMethods = drive.calls.map((entry) => entry.method);
    const renameCall = callMethods.indexOf("rename");
    const successfulShortcutCall = callMethods.lastIndexOf("createShortcut");
    expect(callMethods[renameCall + 1]).toBe("getItem");
    expect(callMethods[successfulShortcutCall + 1]).toBe("getItem");
    expect(ledger.listRunEvents(first.runId)).toHaveLength(4);
    expect(
      ledger
        .listReceipts(first.runId)
        .map((receipt) => receipt.verificationStatus),
    ).toEqual(["Verified", "Failed"]);
    const retainedAuditText = JSON.stringify({
      events: ledger.listRunEvents(first.runId),
      receipts: ledger.listReceipts(first.runId),
    });
    expect(retainedAuditText).not.toContain("fixture-secret");
    expect(retainedAuditText).not.toContain("private-body-marker");
    ledger.close();
  });

  test("re-verifies every prior receipt before resume and makes zero writes when prior live state drifted", async () => {
    const input = inputPlan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
      { now: () => "2026-08-08T17:31:00.000Z" },
    );
    drive.controls.failOnCall("createShortcut", 1, {
      code: "PROVIDER_FAILURE",
      itemId: source.id,
      message: "Synthetic interruption.",
      retryable: true,
    });
    const ledger = ledgerAt(databasePath());
    const inputApproval = approval(input);
    const partial = await applyApprovedPlan({
      approval: inputApproval,
      checkedAt,
      ledger,
      mutationProvider: drive.mutation,
      now: () => "2026-08-08T17:32:00.000Z",
      plan: input,
      providerId: "fake",
      readProvider: drive.read,
    });
    expect(partial.state).toBe("Partial");
    const mutationRequestsBeforeResume = drive.mutationRequests.length;
    const driftedRead: ReadProvider = {
      capability: "read",
      exportItem: (request) => drive.read.exportItem(request),
      getItem: async (itemId) => {
        const result = await drive.read.getItem(itemId);
        return result.ok && result.value?.id === invoice.id
          ? {
              ok: true,
              value: { ...result.value, name: "Drifted after receipt.pdf" },
            }
          : result;
      },
      listItems: (request) => drive.read.listItems(request),
    };

    const blockedResume = await applyApprovedPlan({
      approval: inputApproval,
      checkedAt,
      ledger,
      mutationProvider: drive.mutation,
      now: () => "2026-08-08T17:33:00.000Z",
      plan: input,
      providerId: "fake",
      readProvider: driftedRead,
    });

    expect(blockedResume).toMatchObject({
      mutationCallCount: 0,
      resumeCursor: 0,
      state: "Failed",
    });
    expect(drive.mutationRequests).toHaveLength(mutationRequestsBeforeResume);
    expect(drive.writeCount).toBe(1);
    expect(
      ledger.listRunEvents(blockedResume.runId).map((event) => event.state),
    ).toEqual(["Started", "Failed"]);
    ledger.close();
  });

  test("fails a lying provider response at the live after-state boundary and stores only redacted receipt data", async () => {
    const input = inputPlan();
    const drive = createInstrumentedFakeDrive(
      fixture([root, destination, invoice, source]),
    );
    const calls: string[] = [];
    const lyingMutation: MutationProvider = {
      capability: "mutation",
      createShortcut: () => {
        calls.push("createShortcut");
        return Promise.reject(new Error("A later write must not start."));
      },
      rename: (request) => {
        calls.push("rename");
        return Promise.resolve({
          ok: true,
          value: {
            id: request.targetId,
            modifiedTime: "2026-08-08T17:31:00.000Z",
            name: request.name,
            parentIds: invoice.parentIds,
            shortcutTargetId: invoice.shortcutTargetId,
          },
        });
      },
    };
    const ledger = ledgerAt(databasePath());

    const result = await applyApprovedPlan({
      approval: approval(input),
      checkedAt,
      ledger,
      mutationProvider: lyingMutation,
      now: () => "2026-08-08T17:32:00.000Z",
      plan: input,
      providerId: "fake",
      readProvider: drive.read,
    });

    expect(result).toMatchObject({
      mutationCallCount: 1,
      resumeCursor: 0,
      state: "Partial",
    });
    expect(calls).toEqual(["rename"]);
    const receipts = ledger.listReceipts(result.runId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      failureCode: "AFTER_STATE_MISMATCH",
      verificationStatus: "Failed",
    });
    const stored = JSON.stringify(receipts);
    expect(stored).not.toContain(invoice.id);
    expect(stored).not.toContain(invoice.name);
    expect(stored).not.toContain(desiredInvoiceName);
    expect(stored).not.toContain(source.id);
    expect(ledger.listRunEvents(result.runId).at(-1)?.state).toBe("Partial");
    ledger.close();
  });

  test("verifies and reapplies through the same Drive Lab contracts with zero duplicate writes", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dvw-resume-lab-"));
    const lab = DriveLab.initialize(
      join(temporaryRoot, "lab"),
      "messy-paisano",
    );
    const labInvoice = await requiredItem(lab.read, "messy-invoice-draft");
    const labSource = await requiredItem(lab.read, "messy-board-memo");
    const labDestination = await requiredItem(lab.read, "messy-root");
    const existingShortcut = await requiredItem(
      lab.read,
      "messy-existing-shortcut",
    );
    const labPlan = plan([
      action({
        desiredState: { name: desiredInvoiceName },
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
          source: itemPreconditions(labSource),
        },
        reasonCode: "PAISANO.SHORTCUT.DEAL_DOCUMENT",
        target: labSource,
        type: "CREATE_SHORTCUT",
      }),
    ]);
    const ledger = ledgerAt(join(temporaryRoot, "workbench.sqlite"));

    const first = await applyApprovedPlan({
      approval: approval(labPlan),
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T17:32:00.000Z",
      plan: labPlan,
      providerId: "lab",
      readProvider: lab.read,
    });
    const second = await applyApprovedPlan({
      approval: approval(labPlan),
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T17:33:00.000Z",
      plan: labPlan,
      providerId: "lab",
      readProvider: lab.read,
    });

    expect(first).toMatchObject({
      mutationCallCount: 2,
      state: "Completed",
    });
    expect(second).toMatchObject({
      mutationCallCount: 0,
      state: "Completed",
    });
    expect(lab.writeCount).toBe(2);
    expect(
      ledger
        .listReceipts(second.runId)
        .map((receipt) => receipt.verificationStatus),
    ).toEqual(["Verified", "Verified"]);
    ledger.close();
  });
});
