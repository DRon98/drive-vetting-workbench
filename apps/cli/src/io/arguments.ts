export type CliCommandName =
  | "scan"
  | "inventory"
  | "plan"
  | "questions"
  | "decide"
  | "lab"
  | "pilot"
  | "review"
  | "feedback"
  | "approve"
  | "apply"
  | "verify"
  | "dry-run";

export const FEEDBACK_CLI_OPERATIONS = ["import"] as const;
export type FeedbackCliOperation = (typeof FEEDBACK_CLI_OPERATIONS)[number];

export const PILOT_CLI_OPERATIONS = ["preflight", "scorecard"] as const;
export type PilotCliOperation = (typeof PILOT_CLI_OPERATIONS)[number];

export const LAB_CLI_OPERATIONS = [
  "init",
  "tree",
  "edit",
  "snapshot",
  "diff",
  "reset",
] as const;
export type LabCliOperation = (typeof LAB_CLI_OPERATIONS)[number];

export interface ParsedCliArguments {
  readonly command: CliCommandName;
  readonly feedbackOperation: FeedbackCliOperation | null;
  readonly json: boolean;
  readonly labOperation: LabCliOperation | null;
  readonly options: ReadonlyMap<string, string>;
  readonly pilotOperation: PilotCliOperation | null;
}

const commandOptions: Record<CliCommandName, ReadonlySet<string>> = {
  approve: new Set(["approver", "confirm", "expires-at", "output-dir", "plan"]),
  apply: new Set(["approval", "confirm", "plan", "provider"]),
  decide: new Set(["answer", "answer-json", "approver", "question"]),
  "dry-run": new Set(["approval", "plan", "provider"]),
  feedback: new Set(),
  inventory: new Set(["query"]),
  lab: new Set(),
  plan: new Set(),
  pilot: new Set(),
  questions: new Set(),
  review: new Set(["input", "output-dir"]),
  scan: new Set(["page-size", "provider", "root"]),
  verify: new Set(["plan", "provider", "run"]),
};

const feedbackOperationOptions: Record<
  FeedbackCliOperation,
  ReadonlySet<string>
> = {
  import: new Set(["input", "output-dir", "packet", "packet-json"]),
};

const labOperationOptions: Record<LabCliOperation, ReadonlySet<string>> = {
  diff: new Set(["against", "sandbox"]),
  edit: new Set(["edit-json", "sandbox"]),
  init: new Set(["sandbox", "scenario"]),
  reset: new Set(["sandbox"]),
  snapshot: new Set(["sandbox"]),
  tree: new Set(["sandbox"]),
};

const pilotOperationOptions: Record<PilotCliOperation, ReadonlySet<string>> = {
  preflight: new Set(["input"]),
  scorecard: new Set(["input", "output-dir"]),
};

export class CliUsageError extends Error {
  public readonly code = "INVALID_INPUT" as const;

  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function isCommand(value: string): value is CliCommandName {
  return [
    "scan",
    "inventory",
    "plan",
    "questions",
    "decide",
    "lab",
    "pilot",
    "review",
    "feedback",
    "approve",
    "apply",
    "verify",
    "dry-run",
  ].includes(value);
}

function isPilotOperation(
  value: string | undefined,
): value is PilotCliOperation {
  return (
    value !== undefined &&
    PILOT_CLI_OPERATIONS.includes(value as PilotCliOperation)
  );
}

function isFeedbackOperation(
  value: string | undefined,
): value is FeedbackCliOperation {
  return (
    value !== undefined &&
    FEEDBACK_CLI_OPERATIONS.includes(value as FeedbackCliOperation)
  );
}

function isLabOperation(value: string | undefined): value is LabCliOperation {
  return (
    value !== undefined && LAB_CLI_OPERATIONS.includes(value as LabCliOperation)
  );
}

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
  const requestedCommand = argv[0];
  if (requestedCommand === undefined || !isCommand(requestedCommand)) {
    throw new CliUsageError(
      "Use one command: scan, inventory, plan, questions, decide, lab, pilot, review, feedback, approve, dry-run, apply, or verify.",
    );
  }
  let feedbackOperation: FeedbackCliOperation | null = null;
  let labOperation: LabCliOperation | null = null;
  let pilotOperation: PilotCliOperation | null = null;
  let optionStart = 1;
  if (requestedCommand === "lab") {
    const requestedOperation = argv[1];
    if (!isLabOperation(requestedOperation)) {
      throw new CliUsageError(
        "Lab requires one operation: init, tree, edit, snapshot, diff, or reset.",
      );
    }
    labOperation = requestedOperation;
    optionStart = 2;
  }
  if (requestedCommand === "feedback") {
    const requestedOperation = argv[1];
    if (!isFeedbackOperation(requestedOperation)) {
      throw new CliUsageError("Feedback requires the import operation.");
    }
    feedbackOperation = requestedOperation;
    optionStart = 2;
  }
  if (requestedCommand === "pilot") {
    const requestedOperation = argv[1];
    if (!isPilotOperation(requestedOperation)) {
      throw new CliUsageError(
        "Pilot requires one operation: preflight or scorecard.",
      );
    }
    pilotOperation = requestedOperation;
    optionStart = 2;
  }
  const allowedOptions =
    labOperation !== null
      ? labOperationOptions[labOperation]
      : feedbackOperation !== null
        ? feedbackOperationOptions[feedbackOperation]
        : pilotOperation !== null
          ? pilotOperationOptions[pilotOperation]
          : commandOptions[requestedCommand];
  const options = new Map<string, string>();
  let json = false;
  for (let index = optionStart; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      if (json) throw new CliUsageError("--json can be set only once.");
      json = true;
      continue;
    }
    if (token === undefined || !token.startsWith("--")) {
      throw new CliUsageError("Every command argument must use --name value.");
    }
    const key = token.slice(2);
    if (!allowedOptions.has(key)) {
      throw new CliUsageError(
        `Option --${key} is not valid for ${labOperation ?? feedbackOperation ?? pilotOperation ?? requestedCommand}.`,
      );
    }
    if (options.has(key)) {
      throw new CliUsageError(`Option --${key} can be set only once.`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw new CliUsageError(`Option --${key} needs a value.`);
    }
    options.set(key, value);
    index += 1;
  }
  if (requestedCommand === "approve") {
    for (const required of [
      "plan",
      "approver",
      "confirm",
      "output-dir",
    ] as const) {
      if (!options.has(required)) {
        throw new CliUsageError(`Approve requires --${required}.`);
      }
    }
  }
  if (requestedCommand === "dry-run") {
    for (const required of ["plan", "approval"] as const) {
      if (!options.has(required)) {
        throw new CliUsageError(`Dry-run requires --${required}.`);
      }
    }
  }
  if (requestedCommand === "apply") {
    for (const required of ["plan", "approval", "confirm"] as const) {
      if (!options.has(required)) {
        throw new CliUsageError(`Apply requires --${required}.`);
      }
    }
  }
  if (requestedCommand === "verify") {
    for (const required of ["plan", "run"] as const) {
      if (!options.has(required)) {
        throw new CliUsageError(`Verify requires --${required}.`);
      }
    }
  }
  if (requestedCommand === "scan" && !options.has("root")) {
    throw new CliUsageError("Scan requires an explicit --root folder ID.");
  }
  if (requestedCommand === "decide") {
    for (const required of ["question", "approver"] as const) {
      if (!options.has(required)) {
        throw new CliUsageError(`Decide requires --${required}.`);
      }
    }
    if (options.has("answer") === options.has("answer-json")) {
      throw new CliUsageError(
        "Decide requires exactly one of --answer or --answer-json.",
      );
    }
  }
  if (requestedCommand === "lab") {
    if (!options.has("sandbox")) {
      throw new CliUsageError(
        `Lab ${labOperation ?? "operation"} requires --sandbox.`,
      );
    }
    if (labOperation === "init" && !options.has("scenario")) {
      throw new CliUsageError("Lab init requires --scenario.");
    }
    if (labOperation === "edit" && !options.has("edit-json")) {
      throw new CliUsageError("Lab edit requires --edit-json.");
    }
  }
  if (requestedCommand === "review") {
    for (const required of ["input", "output-dir"] as const) {
      if (!options.has(required)) {
        throw new CliUsageError(`Review requires --${required}.`);
      }
    }
  }
  if (requestedCommand === "feedback") {
    for (const required of ["input", "output-dir"] as const) {
      if (!options.has(required)) {
        throw new CliUsageError(`Feedback import requires --${required}.`);
      }
    }
    if (options.has("packet") === options.has("packet-json")) {
      throw new CliUsageError(
        "Feedback import requires exactly one of --packet or --packet-json.",
      );
    }
  }
  if (requestedCommand === "pilot") {
    if (!options.has("input")) {
      throw new CliUsageError(
        `Pilot ${pilotOperation ?? "operation"} requires --input.`,
      );
    }
    if (pilotOperation === "scorecard" && !options.has("output-dir")) {
      throw new CliUsageError("Pilot scorecard requires --output-dir.");
    }
  }
  return {
    command: requestedCommand,
    feedbackOperation,
    json,
    labOperation,
    options,
    pilotOperation,
  };
}

export function option(
  input: ParsedCliArguments,
  key: string,
): string | undefined {
  return input.options.get(key);
}
