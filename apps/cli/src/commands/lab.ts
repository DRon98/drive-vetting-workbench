import {
  DriveLab,
  DriveLabError,
  LAB_SCENARIOS,
  type LabDiffEntry,
  type LabEdit,
  type LabScenarioName,
} from "@dvw/drive-simulator";
import {
  CliUsageError,
  option,
  type ParsedCliArguments,
} from "../io/arguments.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";

type LabCommandOutput = Extract<CliCommandOutput, { command: "lab" }>;

function isScenario(value: string): value is LabScenarioName {
  return LAB_SCENARIOS.includes(value as LabScenarioName);
}

function sandbox(args: ParsedCliArguments): string {
  const value = option(args, "sandbox");
  if (value === undefined) throw new CliUsageError("Lab requires --sandbox.");
  return value;
}

function parseEdit(value: string | undefined): LabEdit {
  if (value === undefined)
    throw new CliUsageError("Lab edit requires --edit-json.");
  try {
    return JSON.parse(value) as LabEdit;
  } catch {
    throw new CliUsageError("--edit-json must contain one valid JSON object.");
  }
}

function context(runtime: CliRuntime, lab: DriveLab) {
  const snapshot = lab.snapshot();
  return {
    policyVersion: runtime.policyVersion,
    scanGeneration: `lab:${snapshot.hash}`,
    snapshot,
  };
}

function common(lab: DriveLab) {
  const manifest = lab.manifest;
  return {
    labId: manifest.labId,
    rootId: manifest.rootId,
    scenario: manifest.scenario,
    snapshotHash: lab.snapshot().hash,
  };
}

function output(
  runtime: CliRuntime,
  lab: DriveLab,
  data: LabCommandOutput["data"],
): LabCommandOutput {
  const current = context(runtime, lab);
  return {
    command: "lab",
    data,
    policyVersion: current.policyVersion,
    scanGeneration: current.scanGeneration,
    status: "SUCCESS",
  };
}

export async function runLabCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  await Promise.resolve();
  const operation = args.labOperation;
  if (operation === null) throw new CliUsageError("Lab operation is missing.");
  const root = sandbox(args);
  if (operation === "init") {
    const scenario = option(args, "scenario");
    if (scenario === undefined || !isScenario(scenario)) {
      throw new CliUsageError(
        `--scenario must be one of: ${LAB_SCENARIOS.join(", ")}.`,
      );
    }
    const lab = DriveLab.initialize(root, scenario);
    const baselineHash = lab.baselineSnapshot().hash;
    return output(runtime, lab, {
      ...common(lab),
      baselineHash,
      operation,
    });
  }

  const lab = DriveLab.open(root);
  if (operation === "tree") {
    return output(runtime, lab, {
      ...common(lab),
      entries: lab.treeEntries(),
      operation,
    });
  }
  if (operation === "edit") {
    const previousSnapshotHash = lab.snapshot().hash;
    lab.applyEdit(parseEdit(option(args, "edit-json")));
    return output(runtime, lab, {
      ...common(lab),
      entries: lab.diff(previousSnapshotHash),
      operation,
      previousSnapshotHash,
    });
  }
  if (operation === "snapshot") {
    return output(runtime, lab, {
      ...common(lab),
      baselineHash: lab.baselineSnapshot().hash,
      operation,
    });
  }
  if (operation === "diff") {
    const against = option(args, "against") ?? "baseline";
    const referenceSnapshotHash =
      against === "baseline" ? lab.baselineSnapshot().hash : against;
    const entries: LabDiffEntry[] = lab.diff(referenceSnapshotHash);
    return output(runtime, lab, {
      ...common(lab),
      entries,
      operation,
      referenceSnapshotHash,
    });
  }
  lab.reset();
  const baselineHash = lab.baselineSnapshot().hash;
  if (lab.snapshot().hash !== baselineHash) {
    throw new DriveLabError(
      "RESET_MISMATCH",
      "Drive Lab reset did not restore the baseline.",
    );
  }
  return output(runtime, lab, {
    ...common(lab),
    baselineHash,
    operation,
    restoredExact: true,
  });
}
