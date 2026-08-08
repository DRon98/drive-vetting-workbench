import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  SECURITY_THREATS,
  securityCoverageIssues,
} from "../../packages/security/src/index.js";

const REQUIRED_THREAT_IDS = [
  "THR_CLIPBOARD_PACKET_TAMPERING",
  "THR_CSP_BYPASS",
  "THR_DEPENDENCY_COMPROMISE",
  "THR_DRIVE_LAB_PATH_ESCAPE",
  "THR_HTML_SCRIPT_INJECTION",
  "THR_LOG_LEAKAGE",
  "THR_MALICIOUS_DRIVE_NAME",
  "THR_MALICIOUS_FILE_TEXT",
  "THR_MCP_TOOL_CONFUSION",
  "THR_MODEL_OUTPUT_INJECTION",
  "THR_PLAN_TAMPERING",
  "THR_POISONED_POLICY",
  "THR_SCOPE_ESCALATION",
  "THR_STALE_APPROVAL",
  "THR_STALE_FEEDBACK",
  "THR_TOKEN_THEFT",
] as const;

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("T20 threat-to-control matrix", () => {
  test("maps every named threat to a tested preventive or detective control", () => {
    expect(SECURITY_THREATS.map((threat) => threat.id).sort()).toEqual(
      [...REQUIRED_THREAT_IDS].sort(),
    );
    expect(securityCoverageIssues()).toEqual([]);
    expect(
      SECURITY_THREATS.every(
        (threat) =>
          threat.controls.some(
            (control) =>
              control.type === "Preventive" || control.type === "Detective",
          ) && threat.testRefs.length > 0,
      ),
    ).toBe(true);
  });

  test("documents every threat and control and resolves every test reference", () => {
    const threatModel = readFileSync(
      new URL("../../docs/threat-model.md", import.meta.url),
      "utf8",
    );
    const securityPolicy = readFileSync(
      new URL("../../SECURITY.md", import.meta.url),
      "utf8",
    );

    for (const threat of SECURITY_THREATS) {
      expect(threatModel).toContain(threat.id);
      for (const control of threat.controls) {
        expect(threatModel).toContain(control.id);
      }
      for (const reference of threat.testRefs) {
        if (reference.startsWith("tests/")) {
          expect(statSync(`${workspaceRoot}${reference}`).isFile()).toBe(true);
        } else {
          expect(reference).toMatch(/^command:pnpm (?:audit|scan:secrets)/u);
        }
      }
    }

    expect(securityPolicy).toContain("Report a vulnerability");
    expect(securityPolicy).toMatch(/Do not\s+include Buck\s+data/u);
    expect(securityPolicy).toContain("pnpm scan:secrets");
  });
});
