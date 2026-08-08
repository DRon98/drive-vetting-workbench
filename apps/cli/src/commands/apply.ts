import {
  ApprovalValidationError,
  applyApprovedPlan,
  ExecutionLedger,
  parseApprovalArtifact,
  validateApprovalForPlan,
} from "@dvw/execution";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import {
  CliUsageError,
  option,
  type ParsedCliArguments,
} from "../io/arguments.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";
import { loadChangePlan, readBoundedText } from "./approve.js";

const MAX_APPROVAL_BYTES = 1024 * 1024;

function required(args: ParsedCliArguments, name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new CliUsageError(`--${name} is required.`);
  return value;
}

export async function runApplyCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  const plan = loadChangePlan(required(args, "plan"));
  if (required(args, "confirm") !== `APPLY ${plan.planHash}`) {
    throw new CliUsageError(
      `Apply requires exact confirmation: APPLY ${plan.planHash}`,
    );
  }

  let approval;
  try {
    approval = parseApprovalArtifact(
      readBoundedText(
        required(args, "approval"),
        MAX_APPROVAL_BYTES,
        "Approval",
      ),
    );
  } catch (error) {
    if (error instanceof ApprovalValidationError) {
      throw new CliUsageError(`Approval input blocked. ${error.message}`);
    }
    throw error;
  }

  const checkedAt = runtime.now();
  let validatedApproval;
  try {
    validatedApproval = validateApprovalForPlan(approval, plan, {
      now: checkedAt,
    });
  } catch (error) {
    if (error instanceof ApprovalValidationError) {
      throw new CliUsageError(`Apply blocked. ${error.message}`);
    }
    throw error;
  }

  if (runtime.executionProviders === undefined) {
    throw new CliUsageError(
      "Apply requires a separately configured execution provider.",
    );
  }
  const evidenceStore = new EvidenceStore(runtime.databasePath);
  try {
    evidenceStore.migrate();
  } finally {
    evidenceStore.close();
  }
  const ledger = new ExecutionLedger(runtime.databasePath);
  const providerId = option(args, "provider") ?? runtime.defaultProviderId;
  let selectedProviderId: string;
  let result;
  try {
    const selected = await runtime.executionProviders.select({ providerId });
    selectedProviderId = selected.providerId;
    result = await applyApprovedPlan({
      approval: validatedApproval,
      checkedAt,
      ledger,
      mutationProvider: selected.mutation,
      now: runtime.now,
      plan,
      providerId: selected.providerId,
      readProvider: selected.read,
    });
  } catch (error) {
    if (error instanceof ApprovalValidationError) {
      throw new CliUsageError(`Apply blocked. ${error.message}`);
    }
    throw error;
  } finally {
    ledger.close();
  }

  return {
    command: "apply",
    data: {
      acceptedMutationCount: result.acceptedMutationCount,
      approvalChecksum: validatedApproval.checksum,
      checkedAt,
      mutationCallCount: result.mutationCallCount,
      planHash: plan.planHash,
      preflightIssueCount: result.execution?.preflight.issues.length ?? 0,
      providerId: selectedProviderId,
      receiptCount: result.receipts.length,
      resumeCursor: result.resumeCursor,
      results: result.results.map((entry) => {
        if (entry.verification === "Pending") {
          throw new TypeError("Verified apply returned a pending result.");
        }
        return {
          actionId: entry.actionId,
          disposition: entry.disposition,
          failureCode: entry.failure?.code ?? null,
          targetId: entry.targetId,
          type: entry.type,
          verification: entry.verification,
        };
      }),
      runId: result.runId,
      state: result.state,
      stoppedAtActionId: result.execution?.stoppedAtActionId ?? null,
    },
    policyVersion: plan.policyVersion,
    scanGeneration: plan.scanGeneration,
    status: result.state === "Completed" ? "SUCCESS" : "REVIEW_REQUIRED",
  };
}
