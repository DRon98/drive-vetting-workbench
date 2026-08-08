import { describe, expect, test } from "vitest";
import {
  formatSecretScanReport,
  scanRepository,
  scanText,
} from "../../packages/security/src/index.js";

describe("local secret scanner", () => {
  test("detects high-confidence secrets without returning or printing their value", () => {
    const secret = `AKIA${"A1B2C3D4E5F6G7H8"}`;
    const findings = scanText("synthetic/input.ts", `const key = "${secret}";`);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      line: 1,
      path: "synthetic/input.ts",
      ruleId: "AWS_ACCESS_KEY",
    });
    expect(findings[0]?.fingerprint).toMatch(/^[a-f0-9]{12}$/u);
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(formatSecretScanReport(findings)).not.toContain(secret);
  });

  test("requires a rule-specific annotation with a substantive false-positive reason", () => {
    const secret = `AKIA${"Z9Y8X7W6V5U4T3S2"}`;
    expect(
      scanText(
        "synthetic/allowed.ts",
        `const key = "${secret}"; // dvw-secret-scan: allow AWS_ACCESS_KEY - synthetic scanner regression fixture`,
      ),
    ).toEqual([]);
    expect(
      scanText(
        "synthetic/not-allowed.ts",
        `const key = "${secret}"; // dvw-secret-scan: allow AWS_ACCESS_KEY - short`,
      ),
    ).toHaveLength(1);
  });

  test("finds no secret or private-data artifact in the current source tree", () => {
    expect(scanRepository(process.cwd())).toEqual([]);
  });
});
