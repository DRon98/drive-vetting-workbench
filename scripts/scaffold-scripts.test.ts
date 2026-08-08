import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface RootPackage {
  scripts: Record<string, string>;
}

const rootPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as RootPackage;

describe("root verification scripts", () => {
  it("runs scaffold probes through the full CI command", () => {
    expect(rootPackage.scripts.verify).toContain("pnpm verify:scaffold");
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
