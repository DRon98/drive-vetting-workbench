import {
  ExecutionLedger,
  ExecutionLedgerError,
  verifyRecordedRun,
} from "@dvw/execution";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import {
  CliUsageError,
  option,
  type ParsedCliArguments,
} from "../io/arguments.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";
import { loadChangePlan } from "./approve.js";

function required(args: ParsedCliArguments, name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new CliUsageError(`--${name} is required.`);
  return value;
}

export async function runVerifyCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  const plan = loadChangePlan(required(args, "plan"));
  const evidenceStore = new EvidenceStore(runtime.databasePath);
  try {
    evidenceStore.migrate();
  } finally {
    evidenceStore.close();
  }
  const ledger = new ExecutionLedger(runtime.databasePath);
  try {
    const runId = required(args, "run");
    const run = ledger.getRun(runId);
    if (run === null) throw new CliUsageError("Verify run was not found.");
    if (run.planHash !== plan.planHash) {
      throw new CliUsageError("Verify run and plan hashes do not match.");
    }
    const providerId = option(args, "provider") ?? runtime.defaultProviderId;
    const selected = await runtime.providers.select({ providerId });
    let result;
    try {
      result = await verifyRecordedRun({
        ledger,
        plan,
        readProvider: selected.read,
        runId,
      });
    } catch (error) {
      if (error instanceof ExecutionLedgerError) {
        throw new CliUsageError(`Verify blocked. ${error.message}`);
      }
      throw error;
    }
    return {
      command: "verify",
      data: {
        failedActionCount: result.failedActionCount,
        planHash: result.planHash,
        providerId: selected.providerId,
        receiptCount: result.receiptCount,
        results: [...result.results],
        runId: result.runId,
        state: result.state,
        verifiedActionCount: result.verifiedActionCount,
      },
      policyVersion: plan.policyVersion,
      scanGeneration: plan.scanGeneration,
      status: result.state === "Completed" ? "SUCCESS" : "REVIEW_REQUIRED",
    };
  } finally {
    ledger.close();
  }
}
