import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";

const REQUIRED_FILES = Object.freeze([
  "README.md",
  "LICENSE",
  "NOTICE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "package.json",
  "pnpm-workspace.yaml",
  "docs/architecture.md",
  "docs/dependency-licenses.md",
  "docs/drive-lab.md",
  "docs/mcp-hosts.md",
  "docs/policy-packs.md",
  "docs/provider-guide.md",
  "docs/quickstart.md",
  "docs/review-workflow.md",
  "docs/threat-model.md",
  "examples/drive-lab-review.mjs",
  "examples/mcp/claude-desktop.json",
  "examples/mcp/codex.toml",
  "examples/mcp/openai-compatible.json",
  "examples/provider/read-provider.ts",
  "examples/tsconfig.json",
  "packs/paisano/pack.json",
]);

const forbiddenPatterns = Object.freeze([
  /^(?:TASK-PLAN|END-REPORT)\.md$/u,
  /^(?:artifacts|fixtures|receipts|tests)\//u,
  /(?:^|\/)dist\//u,
  /(?:^|\/)__snapshots__\//u,
  /(?:^|\/)node_modules\//u,
  /(?:^|\/)(?:credentials?|client[-_]?secret|oauth|tokens?)[^/]*\.(?:json|key|pem)$/iu,
  /(?:^|\/)\.env(?:\.|$)/u,
  /\.(?:db|sqlite|sqlite3)(?:-|$|\.)/iu,
  /\.(?:log|tgz|tsbuildinfo)$/iu,
  /\.test\.[cm]?[jt]sx?$/u,
  /(?:^|\/)vitest\.config\.[cm]?[jt]s$/u,
]);

export function auditPackedFiles(files) {
  const normalized = [...new Set(files)].sort();
  const issues = [];
  for (const required of REQUIRED_FILES) {
    if (!normalized.includes(required)) {
      issues.push(`Required package file is missing: ${required}`);
    }
  }
  for (const path of normalized) {
    if (forbiddenPatterns.some((pattern) => pattern.test(path))) {
      issues.push(`Forbidden package file: ${path}`);
    }
  }
  return issues;
}

function isMain() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMain()) {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const packs = JSON.parse(output);
  const first = packs[0];
  if (first === undefined)
    throw new Error("npm pack returned no package entry.");
  const files = first.files.map((entry) => entry.path);
  const issues = auditPackedFiles(files);
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`${issue}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `package manifest check passed (${String(files.length)} files, ${String(first.unpackedSize)} unpacked bytes)\n`,
    );
  }
}
