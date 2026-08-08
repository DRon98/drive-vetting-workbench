import { DecisionMemoryError } from "@dvw/decision-memory";
import { runDecideCommand } from "./commands/decide.js";
import { runApplyCommand } from "./commands/apply.js";
import { runApproveCommand } from "./commands/approve.js";
import { runDryRunCommand } from "./commands/dry-run.js";
import { runFeedbackCommand } from "./commands/feedback.js";
import { runInventoryCommand } from "./commands/inventory.js";
import { runLabCommand } from "./commands/lab.js";
import { runPlanCommand } from "./commands/plan.js";
import { runPilotCommand } from "./commands/pilot.js";
import { runQuestionsCommand } from "./commands/questions.js";
import { runReviewCommand } from "./commands/review.js";
import { runScanCommand } from "./commands/scan.js";
import { runVerifyCommand } from "./commands/verify.js";
import {
  CliUsageError,
  parseCliArguments,
  type CliCommandName,
} from "./io/arguments.js";
import {
  CLI_EXIT_CODES,
  type CliCommandOutput,
  type CliOutput,
  type CliRunResult,
  type CliRuntime,
} from "./io/contracts.js";
import { completeResult } from "./io/output.js";
import { DriveLabError } from "@dvw/drive-simulator";

export * from "./io/contracts.js";

function requestedCommand(argv: readonly string[]): string | null {
  return argv[0] ?? null;
}

function errorOutput(
  code: "INTERNAL_FAILURE" | "INVALID_INPUT",
  message: string,
  argv: readonly string[],
): CliOutput {
  return {
    command: "error",
    data: { code, message, requestedCommand: requestedCommand(argv) },
    policyVersion: null,
    scanGeneration: null,
    status: code,
  };
}

async function dispatch(
  command: CliCommandName,
  args: ReturnType<typeof parseCliArguments>,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  if (command === "scan") return runScanCommand(args, runtime);
  if (command === "inventory") return runInventoryCommand(args, runtime);
  if (command === "lab") return runLabCommand(args, runtime);
  if (command === "plan") return runPlanCommand(args, runtime);
  if (command === "pilot") return runPilotCommand(args);
  if (command === "questions") return runQuestionsCommand(args, runtime);
  if (command === "review") return runReviewCommand(args, runtime);
  if (command === "feedback") return runFeedbackCommand(args, runtime);
  if (command === "approve") return runApproveCommand(args, runtime);
  if (command === "dry-run") return runDryRunCommand(args, runtime);
  if (command === "apply") return runApplyCommand(args, runtime);
  if (command === "verify") return runVerifyCommand(args, runtime);
  return runDecideCommand(args, runtime);
}

export async function runCli(
  argv: readonly string[],
  runtime: CliRuntime,
): Promise<CliRunResult> {
  const json = argv.includes("--json");
  try {
    const args = parseCliArguments(argv);
    const output = await dispatch(args.command, args, runtime);
    const exitCode =
      output.status === "SUCCESS"
        ? CLI_EXIT_CODES.SUCCESS
        : output.status === "REVIEW_REQUIRED"
          ? CLI_EXIT_CODES.REVIEW_REQUIRED
          : CLI_EXIT_CODES.COVERAGE_GAP;
    return completeResult(output, exitCode, args.json);
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof DecisionMemoryError ||
      error instanceof DriveLabError
    ) {
      return completeResult(
        errorOutput("INVALID_INPUT", error.message, argv),
        CLI_EXIT_CODES.INVALID_INPUT,
        json,
      );
    }
    return completeResult(
      errorOutput(
        "INTERNAL_FAILURE",
        "The command failed. Review local logs and try again.",
        argv,
      ),
      CLI_EXIT_CODES.INTERNAL_FAILURE,
      json,
    );
  }
}
