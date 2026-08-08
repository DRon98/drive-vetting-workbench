import { statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChangePlanSchema, type ChangePlan } from "@dvw/change-planner";
import {
  ApprovalValidationError,
  createApprovalArtifact,
  writeApprovalArtifactCreateOnly,
} from "@dvw/execution";
import { z } from "zod";
import {
  CliUsageError,
  option,
  type ParsedCliArguments,
} from "../io/arguments.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";

const MAX_PLAN_BYTES = 10 * 1024 * 1024;

function required(args: ParsedCliArguments, name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new CliUsageError(`--${name} is required.`);
  return value;
}

export function readBoundedText(
  path: string,
  maximumBytes: number,
  label: string,
): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new CliUsageError(`${label} cannot be read: ${path}`);
  }
  if (size > maximumBytes) {
    throw new CliUsageError(`${label} exceeds ${maximumBytes} bytes.`);
  }
  return readFileSync(path, "utf8");
}

export function loadChangePlan(path: string): ChangePlan {
  const text = readBoundedText(path, MAX_PLAN_BYTES, "Plan");
  try {
    return ChangePlanSchema.parse(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      throw new CliUsageError(
        `Plan ${first?.path.join(".") || "document"}: ${first?.message ?? "is invalid"}.`,
      );
    }
    throw new CliUsageError("Plan must be one valid JSON object.");
  }
}

export async function runApproveCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  await Promise.resolve();
  const plan = loadChangePlan(required(args, "plan"));
  let artifact;
  try {
    artifact = createApprovalArtifact(plan, {
      approvedAt: runtime.now(),
      approver: required(args, "approver"),
      confirmation: required(args, "confirm"),
      expiresAt: option(args, "expires-at") ?? null,
    });
  } catch (error) {
    if (error instanceof ApprovalValidationError) {
      throw new CliUsageError(`Approval blocked. ${error.message}`);
    }
    throw error;
  }
  const artifactPath = resolve(
    join(
      required(args, "output-dir"),
      `approval-${artifact.planHash}-${artifact.checksum}.json`,
    ),
  );
  writeApprovalArtifactCreateOnly(artifactPath, artifact);
  return {
    command: "approve",
    data: {
      approvalChecksum: artifact.checksum,
      approvedAt: artifact.approvedAt,
      approver: artifact.approver,
      artifactPath,
      expiresAt: artifact.expiresAt,
      planHash: artifact.planHash,
    },
    policyVersion: artifact.policyVersion,
    scanGeneration: artifact.scanGeneration,
    status: "SUCCESS",
  };
}
