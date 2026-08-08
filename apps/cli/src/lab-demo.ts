import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveLabProviderSelector } from "@dvw/drive-simulator";
import { runCli } from "./index.js";
import type { CliRuntime } from "./io/contracts.js";

const workspace = mkdtempSync(join(tmpdir(), "dvw-lab-demo-"));
const labRoot = join(workspace, "lab");
const runtime: CliRuntime = {
  artifactsRoot: join(workspace, "artifacts"),
  databasePath: join(workspace, "workbench.sqlite"),
  defaultProviderId: "lab",
  generationId: () => "scan-lab-demo",
  now: () => "2026-08-08T14:00:00.000Z",
  planning: {
    build: () => {
      throw new Error("The Drive Lab command demo does not run the planner.");
    },
  },
  policyVersion: "1.0.0",
  providers: new DriveLabProviderSelector(labRoot),
};

async function run(label: string, argv: readonly string[]): Promise<void> {
  const result = await runCli(argv, runtime);
  if (result.exitCode !== 0) throw new Error(result.text);
  process.stdout.write(`\n${label}\n${result.text}\n`);
}

await run("INITIALIZE", [
  "lab",
  "init",
  "--sandbox",
  labRoot,
  "--scenario",
  "messy-paisano",
]);
await run("INITIAL TREE", ["lab", "tree", "--sandbox", labRoot]);
await run("EXPLICIT TEST EDIT", [
  "lab",
  "edit",
  "--sandbox",
  labRoot,
  "--edit-json",
  JSON.stringify({
    itemId: "messy-invoice-draft",
    name: "Operator changed invoice.pdf",
    type: "rename",
  }),
]);
await run("CHANGED TREE", ["lab", "tree", "--sandbox", labRoot]);
await run("BASELINE DIFF", [
  "lab",
  "diff",
  "--sandbox",
  labRoot,
  "--against",
  "baseline",
]);
await run("APPEND-ONLY RESET", ["lab", "reset", "--sandbox", labRoot]);
await run("RESTORED SNAPSHOT", ["lab", "snapshot", "--sandbox", labRoot]);
process.stdout.write(`\nSandbox retained for inspection: ${labRoot}\n`);
