import {
  ApprovalValidationError,
  dryRunApprovedPlan,
  parseApprovalArtifact,
} from "@dvw/execution";
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

export async function runDryRunCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  const plan = loadChangePlan(required(args, "plan"));
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
  const providerId = option(args, "provider") ?? runtime.defaultProviderId;
  const selected = await runtime.providers.select({ providerId });
  let result;
  try {
    result = await dryRunApprovedPlan({
      approval,
      checkedAt: runtime.now(),
      plan,
      provider: selected.read,
    });
  } catch (error) {
    if (error instanceof ApprovalValidationError) {
      throw new CliUsageError(`Dry-run blocked. ${error.message}`);
    }
    throw error;
  }
  return {
    command: "dry-run",
    data: {
      approvalChecksum: result.approvalChecksum,
      checkedAt: result.checkedAt,
      issueCount: result.issues.length,
      issues: [...result.issues],
      operationCount: result.operations.length,
      operations: [...result.operations],
      planHash: result.planHash,
      providerId: selected.providerId,
      writeCount: result.writeCount,
    },
    policyVersion: plan.policyVersion,
    scanGeneration: plan.scanGeneration,
    status: result.status === "Ready" ? "SUCCESS" : "REVIEW_REQUIRED",
  };
}
