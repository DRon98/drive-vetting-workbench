import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface RootPackage {
  scripts: Record<string, string>;
}

const rootPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as RootPackage;
const eslintConfigSource = readFileSync(
  new URL("../eslint.config.js", import.meta.url),
  "utf8",
);

describe("root verification scripts", () => {
  it("runs scaffold probes through the full CI command", () => {
    expect(rootPackage.scripts.verify).toContain("pnpm verify:scaffold");
  });

  it("builds workspace declarations once before type-aware checks", () => {
    const scaffoldScript = rootPackage.scripts["verify:scaffold"];
    expect(scaffoldScript).toBeDefined();

    const scaffoldSteps = scaffoldScript?.split(" && ") ?? [];
    const buildIndex = scaffoldSteps.indexOf("pnpm build");

    expect(scaffoldSteps.filter((step) => step === "pnpm build")).toHaveLength(
      1,
    );
    expect(buildIndex).toBeLessThan(scaffoldSteps.indexOf("pnpm lint"));
    expect(buildIndex).toBeLessThan(scaffoldSteps.indexOf("pnpm typecheck"));
  });

  it("keeps retained nested worktrees outside the root lint boundary", () => {
    expect(eslintConfigSource).toContain('".worktrees/**"');
  });

  it.each(["test:integration", "test:e2e", "test:security"])(
    "does not let an empty %s suite pass",
    (scriptName) => {
      expect(rootPackage.scripts[scriptName]).not.toContain("passWithNoTests");
    },
  );

  it("performs a supported package-content dry run", () => {
    expect(rootPackage.scripts["verify:package"]).toContain(
      "npm pack --dry-run --json",
    );
  });

  it("rejects generated compiler artifacts in source directories before packaging", () => {
    expect(rootPackage.scripts["verify:package"]).toContain(
      "pnpm check:source-artifacts",
    );
  });
});
