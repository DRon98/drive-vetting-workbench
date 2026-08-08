import type { ChangePlan } from "@dvw/change-planner";
import type { MutationProvider, ReadProvider } from "@dvw/core";
import {
  validateApprovalForPlan,
  validateCanonicalPlan,
  type ApprovalArtifact,
} from "./approval.js";
import {
  executeApprovedPlan,
  type ExecuteApprovedPlanResult,
  type ExecutionActionResult,
} from "./executor.js";
import {
  ExecutionLedgerError,
  type ExecutionLedger,
  type ReceiptVerificationStatus,
  type ExecutionRunState,
  type StoredExecutionReceipt,
} from "./ledger.js";
import { verifyExecutionAction, verifyPlannedAction } from "./verifier.js";

export interface ApplyApprovedPlanInput {
  readonly approval: ApprovalArtifact;
  readonly checkedAt: string;
  readonly ledger: ExecutionLedger;
  readonly mutationProvider: MutationProvider;
  readonly now: () => string;
  readonly plan: ChangePlan;
  readonly providerId: string;
  readonly readProvider: ReadProvider;
}

export interface AppliedPlanResult {
  readonly acceptedMutationCount: number;
  readonly execution: ExecuteApprovedPlanResult | null;
  readonly mutationCallCount: number;
  readonly receipts: readonly StoredExecutionReceipt[];
  readonly results: readonly ExecutionActionResult[];
  readonly resumeCursor: number;
  readonly runId: string;
  readonly state: Exclude<ExecutionRunState, "Started" | "Running">;
}

export interface RecordedActionVerification {
  readonly actionId: string;
  readonly failureCode: string | null;
  readonly liveStatus: "Failed" | "Verified";
  readonly receiptStatus: ReceiptVerificationStatus | null;
}

export interface RecordedRunVerificationResult {
  readonly failedActionCount: number;
  readonly planHash: string;
  readonly receiptCount: number;
  readonly results: readonly RecordedActionVerification[];
  readonly runId: string;
  readonly state: "Completed" | "Failed";
  readonly verifiedActionCount: number;
}

function resumeCursor(input: ApplyApprovedPlanInput): number {
  const latest = new Map(
    input.ledger
      .latestActionStatuses(input.plan.planHash, input.approval.checksum)
      .map((entry) => [entry.actionId, entry.verificationStatus]),
  );
  const index = input.plan.effectiveActions.findIndex(
    (action) => latest.get(action.actionId) !== "Verified",
  );
  return index === -1 ? input.plan.effectiveActions.length : index;
}

function terminalState(state: ExecutionRunState): AppliedPlanResult["state"] {
  if (state === "Completed" || state === "Partial" || state === "Failed") {
    return state;
  }
  throw new TypeError(`Execution run is not terminal: ${state}.`);
}

export async function applyApprovedPlan(
  input: ApplyApprovedPlanInput,
): Promise<AppliedPlanResult> {
  const approval = validateApprovalForPlan(input.approval, input.plan, {
    now: input.checkedAt,
  });
  const startedAt = input.now();
  const run = input.ledger.startRun({
    approvalChecksum: approval.checksum,
    planHash: input.plan.planHash,
    providerId: input.providerId,
    startedAt,
  });
  const priorStatuses = new Map(
    input.ledger
      .latestActionStatuses(input.plan.planHash, approval.checksum)
      .map((entry) => [entry.actionId, entry.verificationStatus]),
  );
  let priorVerifiedCount = 0;
  for (const [actionIndex, action] of input.plan.effectiveActions.entries()) {
    if (priorStatuses.get(action.actionId) !== "Verified") continue;
    priorVerifiedCount += 1;
    const verification = await verifyPlannedAction({
      action,
      provider: input.readProvider,
    });
    if (verification.result.verification !== "Verified") {
      input.ledger.appendEvent({
        actionId: action.actionId,
        detail: {
          failureCode: verification.result.failure?.code ?? null,
          priorVerifiedCount,
          resumeCursor: actionIndex,
        },
        eventType: "RunFailed",
        occurredAt: input.now(),
        runId: run.runId,
        state: "Failed",
      });
      return {
        acceptedMutationCount: 0,
        execution: null,
        mutationCallCount: 0,
        receipts: [],
        results: [],
        resumeCursor: actionIndex,
        runId: run.runId,
        state: "Failed",
      };
    }
  }

  input.ledger.appendEvent({
    actionId: null,
    detail: { priorVerifiedCount, resumeCursor: resumeCursor(input) },
    eventType: "ResumeValidated",
    occurredAt: input.now(),
    runId: run.runId,
    state: "Running",
  });

  const execution = await executeApprovedPlan({
    approval,
    checkedAt: input.checkedAt,
    finalizeResult: async ({ action, result }) => {
      const verification = await verifyExecutionAction({
        action,
        provider: input.readProvider,
        result,
      });
      const actionIndex = input.plan.effectiveActions.findIndex(
        (candidate) => candidate.actionId === action.actionId,
      );
      if (actionIndex < 0) {
        throw new TypeError(`Action ${action.actionId} is not effective.`);
      }
      const receipt = input.ledger.appendReceipt(run.runId, {
        actionIndex,
        after: verification.after,
        observedItemId: verification.observedItemId,
        recordedAt: input.now(),
        result: verification.result,
      });
      if (receipt.verificationStatus === "Verified") {
        input.ledger.appendEvent({
          actionId: action.actionId,
          detail: { verificationStatus: "Verified" },
          eventType: "ActionVerified",
          occurredAt: input.now(),
          runId: run.runId,
          state: "Running",
        });
      } else {
        const hasVerifiedReceipt = input.ledger
          .listReceipts(run.runId)
          .some((entry) => entry.verificationStatus === "Verified");
        input.ledger.appendEvent({
          actionId: action.actionId,
          detail: {
            failureCode: receipt.failureCode,
            verificationStatus: "Failed",
          },
          eventType: "ActionFailed",
          occurredAt: input.now(),
          runId: run.runId,
          state:
            hasVerifiedReceipt || result.mutationCalled ? "Partial" : "Failed",
        });
      }
      return verification.result;
    },
    mutationProvider: input.mutationProvider,
    plan: input.plan,
    readProvider: input.readProvider,
  });

  const afterExecution = input.ledger.getRun(run.runId);
  if (afterExecution === null) {
    throw new TypeError("Execution run disappeared from the ledger.");
  }
  if (afterExecution.state === "Running") {
    if (execution.state === "Completed") {
      input.ledger.appendEvent({
        actionId: null,
        detail: {
          acceptedMutationCount: execution.acceptedMutationCount,
          mutationCallCount: execution.mutationCallCount,
          receiptCount: execution.results.length,
          resumeCursor: resumeCursor(input),
        },
        eventType: "RunCompleted",
        occurredAt: input.now(),
        runId: run.runId,
        state: "Completed",
      });
    } else {
      input.ledger.appendEvent({
        actionId: execution.stoppedAtActionId,
        detail: {
          acceptedMutationCount: execution.acceptedMutationCount,
          mutationCallCount: execution.mutationCallCount,
          receiptCount: execution.results.length,
          resumeCursor: resumeCursor(input),
        },
        eventType: "RunFailed",
        occurredAt: input.now(),
        runId: run.runId,
        state: "Failed",
      });
    }
  }
  const completed = input.ledger.getRun(run.runId);
  if (completed === null) {
    throw new TypeError("Execution run disappeared after completion.");
  }
  return {
    acceptedMutationCount: execution.acceptedMutationCount,
    execution,
    mutationCallCount: execution.mutationCallCount,
    receipts: input.ledger.listReceipts(run.runId),
    results: execution.results,
    resumeCursor: resumeCursor(input),
    runId: run.runId,
    state: terminalState(completed.state),
  };
}

export async function verifyRecordedRun(input: {
  readonly ledger: ExecutionLedger;
  readonly plan: ChangePlan;
  readonly readProvider: ReadProvider;
  readonly runId: string;
}): Promise<RecordedRunVerificationResult> {
  const plan = validateCanonicalPlan(input.plan);
  const run = input.ledger.getRun(input.runId);
  if (run === null) {
    throw new ExecutionLedgerError("RUN_NOT_FOUND", "Run was not found.");
  }
  if (run.planHash !== plan.planHash) {
    throw new ExecutionLedgerError(
      "PLAN_MISMATCH",
      "Run and plan hashes do not match.",
    );
  }
  if (run.state === "Started" || run.state === "Running") {
    throw new ExecutionLedgerError(
      "RUN_NOT_TERMINAL",
      "Run is not ready for independent verification.",
    );
  }
  const receipts = input.ledger.listReceipts(input.runId);
  const receiptsByAction = new Map(
    receipts.map((receipt) => [receipt.actionId, receipt]),
  );
  const results: RecordedActionVerification[] = [];
  for (const action of plan.effectiveActions) {
    const receipt = receiptsByAction.get(action.actionId);
    const live = await verifyPlannedAction({
      action,
      provider: input.readProvider,
    });
    const liveStatus =
      live.result.verification === "Verified" ? "Verified" : "Failed";
    results.push({
      actionId: action.actionId,
      failureCode: live.result.failure?.code ?? null,
      liveStatus,
      receiptStatus: receipt?.verificationStatus ?? null,
    });
  }
  const verifiedActionCount = results.filter(
    (result) =>
      result.liveStatus === "Verified" && result.receiptStatus === "Verified",
  ).length;
  const failedActionCount = results.length - verifiedActionCount;
  return {
    failedActionCount,
    planHash: plan.planHash,
    receiptCount: receipts.length,
    results,
    runId: input.runId,
    state: failedActionCount === 0 ? "Completed" : "Failed",
    verifiedActionCount,
  };
}
