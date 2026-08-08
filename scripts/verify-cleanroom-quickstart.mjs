import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const container = mkdtempSync(join(tmpdir(), "dvw-cleanroom-"));
const workspace = join(container, "workspace");
const excludedTopLevel = new Set([
  ".codebase-memory",
  ".dvw",
  ".git",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "receipts",
]);

cpSync(sourceRoot, workspace, {
  dereference: false,
  errorOnExist: true,
  filter: (source) => {
    const path = relative(sourceRoot, source);
    if (path === "") return true;
    const first = path.split(sep)[0];
    if (first !== undefined && excludedTopLevel.has(first)) return false;
    const name = basename(source);
    return (
      !name.endsWith(".tgz") &&
      !name.endsWith(".sqlite") &&
      !name.endsWith(".sqlite-shm") &&
      !name.endsWith(".sqlite-wal")
    );
  },
  force: false,
  recursive: true,
});

const installOutput = execFileSync(
  "pnpm",
  ["install", "--frozen-lockfile", "--offline"],
  {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const quickstartOutput = execFileSync("pnpm", ["quickstart:lab"], {
  cwd: workspace,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const marker = quickstartOutput
  .split(/\r?\n/u)
  .find((line) => line.startsWith("QUICKSTART_RESULT "));
if (marker === undefined) {
  throw new Error("The clean-room quick start did not emit its result marker.");
}
const result = JSON.parse(marker.slice("QUICKSTART_RESULT ".length));
if (
  result.state !== "Completed" ||
  result.feedbackRoundTrip !== true ||
  result.feedbackApprovalGranted !== false ||
  result.dryRunWriteCount !== 0 ||
  result.appliedMutationCount !== 1 ||
  result.idempotentReplayMutationCount !== 0 ||
  result.networkCallCount !== 0 ||
  result.verifiedActionCount !== 1
) {
  throw new Error("The clean-room quick-start evidence is incomplete.");
}
process.stdout.write(
  `clean-room quick start passed ${JSON.stringify({
    install: installOutput.includes("Done") ? "Done" : "Completed",
    result,
    workspace,
  })}\n`,
);
