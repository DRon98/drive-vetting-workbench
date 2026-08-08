import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("ESLint configuration", () => {
  it("lints JavaScript utility scripts without type-aware parser failures", () => {
    const result = spawnSync(
      "pnpm",
      ["exec", "eslint", "scripts/check-sqlite.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    const output = `${result.stdout}${result.stderr}`;

    expect(output).not.toContain("requires type information");
    expect(output).not.toContain("MODULE_TYPELESS_PACKAGE_JSON");
    expect(result.status).toBe(0);
  });

  it("finds root TypeScript files through the project service", () => {
    const result = spawnSync(
      "pnpm",
      ["exec", "eslint", "scripts/determinism.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(output).not.toContain("was not found by the project service");
    expect(result.status).toBe(0);
  });
});
