import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DriveLab,
  LAB_SCENARIOS,
  type LabScenarioName,
} from "@dvw/drive-simulator";

export interface FixtureResetEvidence {
  readonly operation: "Initialized" | "Reset";
  readonly scenario: LabScenarioName;
  readonly stateHash: string;
}

export function resetAdversarialFixtures(
  root: string,
): readonly FixtureResetEvidence[] {
  return LAB_SCENARIOS.map((scenario) => {
    const sandbox = join(root, scenario);
    const operation = existsSync(sandbox) ? "Reset" : "Initialized";
    const lab =
      operation === "Reset"
        ? DriveLab.open(sandbox)
        : DriveLab.initialize(sandbox, scenario);
    if (lab.manifest.scenario !== scenario) {
      throw new Error(
        `Fixture root ${scenario} contains ${lab.manifest.scenario}.`,
      );
    }
    if (operation === "Reset") lab.reset();
    const current = lab.snapshot();
    const baseline = lab.baselineSnapshot();
    if (current.hash !== baseline.hash) {
      throw new Error(`Fixture reset did not restore ${scenario}.`);
    }
    return { operation, scenario, stateHash: current.hash };
  });
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
  const result = resetAdversarialFixtures(
    join(workspaceRoot, "artifacts/local/adversarial/labs"),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
