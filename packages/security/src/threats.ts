export type SecurityControlType = "Corrective" | "Detective" | "Preventive";

export type SecurityControlLayer =
  "Application" | "Data" | "Endpoint" | "Process";

export interface SecurityControl {
  readonly id: string;
  readonly layer: SecurityControlLayer;
  readonly name: string;
  readonly type: SecurityControlType;
}

export interface SecurityThreat {
  readonly category:
    | "Denial of Service"
    | "Elevation of Privilege"
    | "Information Disclosure"
    | "Repudiation"
    | "Spoofing"
    | "Tampering";
  readonly controls: readonly SecurityControl[];
  readonly id: string;
  readonly impact: "Critical" | "High" | "Low" | "Medium";
  readonly likelihood: "High" | "Low" | "Medium";
  readonly name: string;
  readonly testRefs: readonly string[];
}

const preventive = (
  id: string,
  name: string,
  layer: SecurityControlLayer = "Application",
): SecurityControl => ({ id, layer, name, type: "Preventive" });

const detective = (
  id: string,
  name: string,
  layer: SecurityControlLayer = "Application",
): SecurityControl => ({ id, layer, name, type: "Detective" });

export const SECURITY_THREATS: readonly SecurityThreat[] = [
  {
    category: "Tampering",
    controls: [
      preventive("CTRL_FEEDBACK_SCHEMA", "Strict feedback schema and checksum"),
      detective("CTRL_FEEDBACK_CONTEXT", "Plan and review-round binding"),
    ],
    id: "THR_CLIPBOARD_PACKET_TAMPERING",
    impact: "High",
    likelihood: "Medium",
    name: "Clipboard feedback packet tampering",
    testRefs: ["tests/security/review-feedback-boundaries.test.ts"],
  },
  {
    category: "Elevation of Privilege",
    controls: [
      preventive("CTRL_CSP_HASH", "Hash-bound offline content security policy"),
      detective(
        "CTRL_OFFLINE_ARTIFACT_SCAN",
        "Generated artifact network scan",
      ),
    ],
    id: "THR_CSP_BYPASS",
    impact: "High",
    likelihood: "Low",
    name: "Content security policy bypass",
    testRefs: ["tests/security/review-feedback-boundaries.test.ts"],
  },
  {
    category: "Tampering",
    controls: [
      preventive("CTRL_LOCKFILE", "Pinned workspace lockfile", "Process"),
      detective(
        "CTRL_DEPENDENCY_AUDIT",
        "High-severity dependency audit",
        "Process",
      ),
    ],
    id: "THR_DEPENDENCY_COMPROMISE",
    impact: "High",
    likelihood: "Medium",
    name: "Known vulnerable dependency",
    testRefs: ["command:pnpm audit --audit-level high"],
  },
  {
    category: "Elevation of Privilege",
    controls: [
      preventive(
        "CTRL_LAB_CANONICAL_PATH",
        "Canonical sandbox path enforcement",
      ),
      detective("CTRL_LAB_SYMLINK_REJECTION", "Symlink escape rejection"),
    ],
    id: "THR_DRIVE_LAB_PATH_ESCAPE",
    impact: "Critical",
    likelihood: "Medium",
    name: "Drive Lab path or symlink escape",
    testRefs: ["tests/security/provider-isolation.test.ts"],
  },
  {
    category: "Elevation of Privilege",
    controls: [
      preventive("CTRL_HTML_ESCAPE", "Context-safe HTML and JSON escaping"),
      preventive("CTRL_CSP_HASH", "Hash-bound offline content security policy"),
    ],
    id: "THR_HTML_SCRIPT_INJECTION",
    impact: "Critical",
    likelihood: "High",
    name: "HTML or script injection",
    testRefs: ["tests/security/review-feedback-boundaries.test.ts"],
  },
  {
    category: "Information Disclosure",
    controls: [
      preventive("CTRL_LOG_REDACTION", "Bounded redacted errors and receipts"),
      detective(
        "CTRL_SECRET_SCAN",
        "Local high-confidence secret scan",
        "Process",
      ),
    ],
    id: "THR_LOG_LEAKAGE",
    impact: "High",
    likelihood: "Medium",
    name: "Secret or private content in logs",
    testRefs: [
      "tests/security/redaction-boundaries.test.ts",
      "tests/security/secret-scan.test.ts",
      "command:pnpm scan:secrets",
    ],
  },
  {
    category: "Elevation of Privilege",
    controls: [
      preventive("CTRL_HTML_ESCAPE", "Context-safe HTML and JSON escaping"),
    ],
    id: "THR_MALICIOUS_DRIVE_NAME",
    impact: "High",
    likelihood: "High",
    name: "Executable markup in a Drive item name",
    testRefs: ["tests/security/review-feedback-boundaries.test.ts"],
  },
  {
    category: "Elevation of Privilege",
    controls: [
      preventive(
        "CTRL_UNTRUSTED_EVIDENCE",
        "Explicit untrusted evidence envelope",
      ),
      preventive(
        "CTRL_MODEL_NO_TOOLS",
        "Fixed no-tool and no-mutation model contract",
      ),
    ],
    id: "THR_MALICIOUS_FILE_TEXT",
    impact: "Critical",
    likelihood: "High",
    name: "Instruction injection in file text",
    testRefs: ["tests/security/injection-boundaries.test.ts"],
  },
  {
    category: "Elevation of Privilege",
    controls: [
      preventive("CTRL_MCP_ALLOWLIST", "Fixed read-only MCP tool allowlist"),
      detective(
        "CTRL_MCP_PACKAGE_BOUNDARY",
        "Mutation dependency isolation check",
      ),
    ],
    id: "THR_MCP_TOOL_CONFUSION",
    impact: "Critical",
    likelihood: "Medium",
    name: "MCP mutation or tool confusion",
    testRefs: ["tests/security/provider-isolation.test.ts"],
  },
  {
    category: "Elevation of Privilege",
    controls: [
      preventive("CTRL_MODEL_SCHEMA", "Strict bounded model response schema"),
      preventive(
        "CTRL_MODEL_NO_TOOLS",
        "Fixed no-tool and no-mutation model contract",
      ),
    ],
    id: "THR_MODEL_OUTPUT_INJECTION",
    impact: "Critical",
    likelihood: "High",
    name: "Injected action or tool in model output",
    testRefs: ["tests/security/injection-boundaries.test.ts"],
  },
  {
    category: "Tampering",
    controls: [
      preventive("CTRL_PLAN_CANONICAL_HASH", "Canonical plan hash validation"),
      detective("CTRL_APPROVAL_BINDING", "Approval-to-plan binding"),
    ],
    id: "THR_PLAN_TAMPERING",
    impact: "Critical",
    likelihood: "Medium",
    name: "Plan modification after review",
    testRefs: ["tests/security/approval-policy-boundaries.test.ts"],
  },
  {
    category: "Tampering",
    controls: [
      preventive("CTRL_POLICY_SCHEMA", "Strict policy-pack schema"),
      detective("CTRL_POLICY_CONSISTENCY", "Policy contradiction checks"),
    ],
    id: "THR_POISONED_POLICY",
    impact: "High",
    likelihood: "Medium",
    name: "Poisoned local policy file",
    testRefs: ["tests/security/injection-boundaries.test.ts"],
  },
  {
    category: "Elevation of Privilege",
    controls: [
      preventive("CTRL_SCOPE_PROFILES", "Separate exact-scope OAuth profiles"),
      detective(
        "CTRL_AUTH_MODE_GUARD",
        "Runtime authorization-mode validation",
      ),
    ],
    id: "THR_SCOPE_ESCALATION",
    impact: "Critical",
    likelihood: "Medium",
    name: "Read profile escalates to write scope",
    testRefs: ["tests/security/provider-isolation.test.ts"],
  },
  {
    category: "Spoofing",
    controls: [
      preventive("CTRL_APPROVAL_EXPIRY", "Approval time and expiry validation"),
      detective("CTRL_APPROVAL_BINDING", "Approval-to-plan binding"),
    ],
    id: "THR_STALE_APPROVAL",
    impact: "Critical",
    likelihood: "Medium",
    name: "Expired or stale approval",
    testRefs: ["tests/security/approval-policy-boundaries.test.ts"],
  },
  {
    category: "Tampering",
    controls: [
      preventive("CTRL_FEEDBACK_SCHEMA", "Strict feedback schema and checksum"),
      detective("CTRL_FEEDBACK_CONTEXT", "Plan and review-round binding"),
    ],
    id: "THR_STALE_FEEDBACK",
    impact: "High",
    likelihood: "High",
    name: "Feedback imported into a different plan or round",
    testRefs: ["tests/security/review-feedback-boundaries.test.ts"],
  },
  {
    category: "Information Disclosure",
    controls: [
      preventive(
        "CTRL_TOKEN_PERMISSIONS",
        "Exclusive token files with restrictive modes",
        "Data",
      ),
      preventive(
        "CTRL_TOKEN_CANONICAL_PATH",
        "Token storage outside the workspace",
        "Data",
      ),
      detective(
        "CTRL_SECRET_SCAN",
        "Local high-confidence secret scan",
        "Process",
      ),
    ],
    id: "THR_TOKEN_THEFT",
    impact: "Critical",
    likelihood: "Medium",
    name: "OAuth token disclosure or repository storage",
    testRefs: [
      "tests/security/provider-isolation.test.ts",
      "tests/security/secret-scan.test.ts",
    ],
  },
];

export function securityCoverageIssues(
  threats: readonly SecurityThreat[] = SECURITY_THREATS,
): string[] {
  const issues: string[] = [];
  const threatIds = new Set<string>();
  for (const threat of threats) {
    if (threatIds.has(threat.id))
      issues.push(`Duplicate threat ID: ${threat.id}`);
    threatIds.add(threat.id);
    if (threat.controls.length === 0)
      issues.push(`Uncontrolled threat: ${threat.id}`);
    if (
      !threat.controls.some(
        (control) =>
          control.type === "Preventive" || control.type === "Detective",
      )
    ) {
      issues.push(`No preventive or detective control: ${threat.id}`);
    }
    if (threat.testRefs.length === 0)
      issues.push(`Untested threat: ${threat.id}`);
  }
  return issues.sort();
}
