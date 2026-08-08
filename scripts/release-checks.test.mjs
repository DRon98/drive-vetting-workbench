import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, test } from "vitest";
import { checkDocumentation } from "./check-docs.mjs";
import { auditLicenseReport } from "./check-licenses.mjs";
import { auditPackedFiles } from "./check-package-manifest.mjs";

describe("release documentation and package checks", () => {
  test("copies migration contents idempotently into the built directory", () => {
    const workspaceRoot = resolve(
      fileURLToPath(new URL("..", import.meta.url)),
    );
    const manifest = JSON.parse(
      readFileSync(
        join(workspaceRoot, "packages/evidence-store-sqlite/package.json"),
        "utf8",
      ),
    );
    expect(manifest.scripts.build).toContain(
      "mkdir -p dist/migrations && cp -R src/migrations/. dist/migrations/",
    );
  });

  test("accepts local Markdown links, anchors, and registered root commands", () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-docs-pass-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { "quickstart:lab": "node example.mjs" } }),
    );
    writeFileSync(
      join(root, "README.md"),
      [
        "# Start here",
        "",
        "Read the [guide](docs/guide.md#safe-step).",
        "",
        "```bash",
        "pnpm install --frozen-lockfile",
        "pnpm quickstart:lab",
        "```",
      ].join("\n"),
    );
    writeFileSync(join(root, "docs/guide.md"), "# Guide\n\n## Safe step\n");

    expect(checkDocumentation(root)).toEqual([]);
  });

  test("reports missing links, anchors, and undocumented package commands", () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-docs-fail-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(
      join(root, "README.md"),
      [
        "# Broken",
        "",
        "[Missing file](docs/nope.md)",
        "[Missing anchor](README.md#nope)",
        "",
        "```bash",
        "pnpm imaginary-command",
        "```",
      ].join("\n"),
    );

    expect(checkDocumentation(root)).toEqual([
      "README.md: anchor does not exist: README.md#nope",
      "README.md: link target does not exist: docs/nope.md",
      "README.md: root package script does not exist: imaginary-command",
    ]);
  });

  test("allows the reviewed license policy and rejects unknown classes", () => {
    const reviewed = {
      "Apache-2.0": [{ name: "alpha", versions: ["1.0.0"] }],
      MIT: [{ name: "beta", versions: ["2.0.0"] }],
    };
    expect(
      auditLicenseReport(reviewed, new Set(["Apache-2.0", "MIT"])),
    ).toEqual([]);
    expect(auditLicenseReport(reviewed, new Set(["Apache-2.0"]))).toEqual([
      "Unreviewed dependency license MIT: beta@2.0.0",
    ]);
  });

  test("requires release files and rejects private or generated package entries", () => {
    const required = [
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
    ];
    expect(auditPackedFiles(required)).toEqual([]);
    expect(
      auditPackedFiles([
        ...required.filter((path) => path !== "NOTICE"),
        "TASK-PLAN.md",
        "tests/e2e/private.test.ts",
        "artifacts/local/run.json",
        "packages/core/dist/index.js",
        "token.json",
      ]),
    ).toEqual([
      "Required package file is missing: NOTICE",
      "Forbidden package file: TASK-PLAN.md",
      "Forbidden package file: artifacts/local/run.json",
      "Forbidden package file: packages/core/dist/index.js",
      "Forbidden package file: tests/e2e/private.test.ts",
      "Forbidden package file: token.json",
    ]);
  });
});
