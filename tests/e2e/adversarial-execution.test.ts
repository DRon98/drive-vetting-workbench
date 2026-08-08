import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangePlanSchema, type ChangePlan } from "@dvw/change-planner";
import {
  createActionId,
  type ObservedItem,
  type ProposedAction,
  type ReadProvider,
} from "@dvw/core";
import { DriveLab } from "@dvw/drive-simulator";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import {
  applyApprovedPlan,
  createApprovalArtifact,
  dryRunApprovedPlan,
  ExecutionLedger,
  verifyRecordedRun,
} from "@dvw/execution";
import { describe, expect, test } from "vitest";

const checkedAt = "2026-08-08T17:30:00.000Z";
const policyVersion = "1.0.0";

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

function renameAction(
  target: ObservedItem,
  desiredName: string,
  scanGeneration: string,
): ProposedAction {
  const desiredState = { name: desiredName };
  return {
    actionId: createActionId({
      desiredState,
      planIdentity: `${scanGeneration}\u0000${policyVersion}`,
      targetId: target.id,
      type: "RENAME",
    }),
    confidence: 0.96,
    desiredState,
    evidenceIds: [`fact-${target.id}-name`],
    policyVersion,
    preconditions: itemPreconditions(target),
    reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
    reviewState: "Pending",
    scanGeneration,
    targetId: target.id,
    type: "RENAME",
  };
}

function plan(actions: readonly ProposedAction[]): ChangePlan {
  const scanGeneration = actions[0]?.scanGeneration;
  if (scanGeneration === undefined) throw new Error("Plan needs one action.");
  const authorization = {
    actions: actions.map((action) => ({
      actionId: action.actionId,
      desiredState: action.desiredState,
      evidenceIds: action.evidenceIds,
      policyVersion: action.policyVersion,
      preconditions: action.preconditions,
      reasonCode: action.reasonCode,
      scanGeneration: action.scanGeneration,
      targetId: action.targetId,
      type: action.type,
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
    explanations: actions.map((action) => ({
      actionId: action.actionId,
      summary: `Rename ${action.targetId} under the synthetic naming rule.`,
      writeRequired: true,
    })),
    hashContract: "dvw.change-plan.v1",
    planHash: createHash("sha256").update(canonicalJson).digest("hex"),
    policyVersion,
    scanGeneration,
  });
}

function approval(input: ChangePlan) {
  return createApprovalArtifact(input, {
    approvedAt: "2026-08-08T17:00:00.000Z",
    approver: "Synthetic fixture operator",
    confirmation: `APPROVE ${input.planHash}`,
    expiresAt: "2026-08-08T18:00:00.000Z",
  });
}

async function requiredItem(
  provider: ReadProvider,
  itemId: string,
): Promise<ObservedItem> {
  const result = await provider.getItem(itemId);
  if (!result.ok || result.value === null) {
    throw new Error(`Synthetic item ${itemId} is missing.`);
  }
  return result.value;
}

function ledgerAt(root: string): ExecutionLedger {
  const path = join(root, "execution.sqlite");
  const store = new EvidenceStore(path);
  store.migrate();
  store.close();
  return new ExecutionLedger(path);
}

describe("T21 adversarial execution, recovery, and idempotency", () => {
  test("blocks stale state after approval before the first write", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-e2e-stale-"));
    const lab = DriveLab.initialize(join(root, "lab"), "stale-after-approval");
    const target = await requiredItem(lab.read, "stale-target");
    const input = plan([
      renameAction(
        target,
        "2026-08-08 - Synthetic Approved Name.pdf",
        target.scanGeneration,
      ),
    ]);
    const artifact = approval(input);
    lab.applyEdit({
      itemId: target.id,
      name: "Synthetic operator change after approval.pdf",
      type: "rename",
    });

    const dryRun = await dryRunApprovedPlan({
      approval: artifact,
      checkedAt,
      plan: input,
      provider: lab.read,
    });
    expect(dryRun).toMatchObject({ status: "Blocked", writeCount: 0 });
    expect(dryRun.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["STALE_MODIFIED_TIME", "STALE_NAME"]),
    );

    const ledger = ledgerAt(root);
    const applied = await applyApprovedPlan({
      approval: artifact,
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T17:31:00.000Z",
      plan: input,
      providerId: "drive-lab",
      readProvider: lab.read,
    });
    expect(applied).toMatchObject({
      mutationCallCount: 0,
      state: "Failed",
    });
    expect(lab.writeCount).toBe(0);
    expect(lab.mutationRequests).toEqual([]);
    ledger.close();
  });

  test("resumes after a partial failure, verifies receipts, and makes a later apply zero-write", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-e2e-resume-"));
    const lab = DriveLab.initialize(join(root, "lab"), "partial-failure");
    const one = await requiredItem(lab.read, "partial-one");
    const two = await requiredItem(lab.read, "partial-two");
    const input = plan([
      renameAction(one, "2026-08-08 - Synthetic One.pdf", one.scanGeneration),
      renameAction(two, "2026-08-08 - Synthetic Two.pdf", two.scanGeneration),
    ]);
    const artifact = approval(input);
    const ledger = ledgerAt(root);

    const dryRun = await dryRunApprovedPlan({
      approval: artifact,
      checkedAt,
      plan: input,
      provider: lab.read,
    });
    expect(dryRun).toMatchObject({
      status: "Ready",
      writeCount: 0,
    });
    expect(lab.writeCount).toBe(0);

    const first = await applyApprovedPlan({
      approval: artifact,
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T17:32:00.000Z",
      plan: input,
      providerId: "drive-lab",
      readProvider: lab.read,
    });
    expect(first).toMatchObject({
      mutationCallCount: 2,
      resumeCursor: 1,
      state: "Partial",
    });
    expect(first.receipts.map((receipt) => receipt.verificationStatus)).toEqual(
      ["Verified", "Failed"],
    );
    expect(lab.writeCount).toBe(1);

    const second = await applyApprovedPlan({
      approval: artifact,
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T17:33:00.000Z",
      plan: input,
      providerId: "drive-lab",
      readProvider: lab.read,
    });
    expect(second).toMatchObject({
      mutationCallCount: 1,
      resumeCursor: 2,
      state: "Completed",
    });
    expect(lab.writeCount).toBe(2);
    expect(lab.mutationRequests.map((request) => request.method)).toEqual([
      "rename",
      "rename",
      "rename",
    ]);

    const verified = await verifyRecordedRun({
      ledger,
      plan: input,
      readProvider: lab.read,
      runId: second.runId,
    });
    expect(verified).toMatchObject({
      failedActionCount: 0,
      receiptCount: 2,
      state: "Completed",
      verifiedActionCount: 2,
    });
    const beforeThirdApply = lab.mutationRequests.length;

    const third = await applyApprovedPlan({
      approval: artifact,
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T17:34:00.000Z",
      plan: input,
      providerId: "drive-lab",
      readProvider: lab.read,
    });
    expect(third).toMatchObject({
      mutationCallCount: 0,
      resumeCursor: 2,
      state: "Completed",
    });
    expect(lab.writeCount).toBe(2);
    expect(lab.mutationRequests).toHaveLength(beforeThirdApply);
    expect(
      lab.manifest.nodes.filter((node) => node.shortcutTargetId !== null),
    ).toHaveLength(0);
    ledger.close();
  });
});
