import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepository } from "@dvw/security";
import { describe, expect, test } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("T21 synthetic-only boundary", () => {
  test("contains no secret finding and gives adversarial code no real-provider path", () => {
    expect(scanRepository(workspaceRoot)).toEqual([]);

    const matrix = JSON.parse(
      readFileSync(
        join(workspaceRoot, "fixtures/adversarial/scenarios.json"),
        "utf8",
      ),
    ) as {
      readonly fixtureData: string;
      readonly providerMutations: readonly string[];
    };
    expect(matrix.fixtureData).toBe("synthetic-only");
    expect(matrix.providerMutations).toEqual(["rename", "createShortcut"]);

    const e2eRoot = join(workspaceRoot, "tests/e2e");
    const inspected = [
      join(workspaceRoot, "scripts/reset-fixtures.ts"),
      join(workspaceRoot, "fixtures/adversarial/scenarios.json"),
      ...readdirSync(e2eRoot)
        .filter(
          (name) => name.endsWith(".ts") && name !== "no-real-data.test.ts",
        )
        .map((name) => join(e2eRoot, name)),
    ];
    const text = inspected.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(text).not.toContain("@dvw/drive-google");
    expect(text).not.toContain("DVW_GOOGLE_SANDBOX");
    expect(text).not.toContain("process.env");
    expect(text).not.toContain("googleapis.com/auth/");
  });
});
