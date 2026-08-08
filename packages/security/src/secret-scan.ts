import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface SecretFinding {
  readonly column: number;
  readonly fingerprint: string;
  readonly line: number;
  readonly path: string;
  readonly ruleId: string;
}

interface SecretRule {
  readonly flags: string;
  readonly id: string;
  readonly source: string;
}

const RULES: readonly SecretRule[] = [
  {
    flags: "gu",
    id: "PRIVATE_KEY",
    source: "-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----",
  },
  {
    flags: "gu",
    id: "AWS_ACCESS_KEY",
    source: "\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b",
  },
  {
    flags: "gu",
    id: "GITHUB_TOKEN",
    source: "\\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\\b",
  },
  { flags: "gu", id: "GOOGLE_API_KEY", source: "\\bAIza[A-Za-z0-9_-]{30,}\\b" },
  {
    flags: "gu",
    id: "GOOGLE_OAUTH_TOKEN",
    source: "\\bya29\\.[A-Za-z0-9_-]{20,}\\b",
  },
  {
    flags: "gu",
    id: "SLACK_TOKEN",
    source: "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b",
  },
  {
    flags: "giu",
    id: "SECRET_ASSIGNMENT",
    source: String.raw`(?:api[_-]?key|client[_-]?secret|password|refresh[_-]?token|secret|token)\s*[:=]\s*["']([^"'\r\n]{20,})["']`,
  },
];

const EXCLUDED_DIRECTORIES = new Set([
  ".codebase-memory",
  ".git",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
]);
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const SYNTHETIC_MARKERS =
  /(?:dummy|example|fixture|placeholder|redacted|replace[-_ ]?me|synthetic|test[-_ ])/iu;

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizedPath(path: string): string {
  return path.split(sep).join("/");
}

function location(
  text: string,
  index: number,
): { column: number; line: number } {
  const prefix = text.slice(0, index);
  const lines = prefix.split(/\r?\n/u);
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length };
}

function hasAllowance(
  lines: readonly string[],
  line: number,
  ruleId: string,
): boolean {
  const candidates = [lines[line - 1] ?? "", lines[line - 2] ?? ""];
  return candidates.some((candidate) => {
    const match = candidate.match(
      /dvw-secret-scan:\s*allow\s+([A-Z][A-Z0-9_]*)\s+-\s+([^\r\n]+)/u,
    );
    return match?.[1] === ruleId && (match[2]?.trim().length ?? 0) >= 16;
  });
}

export function scanText(path: string, text: string): SecretFinding[] {
  const lines = text.split(/\r?\n/u);
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    const expression = new RegExp(rule.source, rule.flags);
    for (const match of text.matchAll(expression)) {
      const matched = match[0];
      if (SYNTHETIC_MARKERS.test(matched)) continue;
      const index = match.index;
      if (index === undefined) continue;
      const foundAt = location(text, index);
      if (hasAllowance(lines, foundAt.line, rule.id)) continue;
      findings.push({
        ...foundAt,
        fingerprint: fingerprint(matched),
        path: normalizedPath(path),
        ruleId: rule.id,
      });
    }
  }
  return findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORIES.has(name);
}

function collect(root: string, directory: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (entry.isDirectory() && isExcludedDirectory(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    const path = normalizedPath(relative(root, absolute));
    if (entry.isSymbolicLink()) {
      findings.push({
        column: 1,
        fingerprint: fingerprint(path),
        line: 1,
        path,
        ruleId: "UNSCANNED_SYMLINK",
      });
      continue;
    }
    if (entry.isDirectory()) {
      findings.push(...collect(root, absolute));
      continue;
    }
    if (!entry.isFile() || statSync(absolute).size > MAX_TEXT_FILE_BYTES)
      continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    findings.push(...scanText(path, bytes.toString("utf8")));
  }
  return findings;
}

export function scanRepository(rootInput: string): SecretFinding[] {
  const root = resolve(rootInput);
  if (!lstatSync(root).isDirectory()) {
    throw new TypeError("The secret-scan root must be a directory.");
  }
  return collect(root, root).sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

export function formatSecretScanReport(
  findings: readonly SecretFinding[],
): string {
  if (findings.length === 0) return "Secret scan passed: no findings.";
  return [
    `Secret scan failed: ${findings.length} finding(s).`,
    ...findings.map(
      (finding) =>
        `${finding.path}:${finding.line}:${finding.column} ${finding.ruleId} fingerprint=${finding.fingerprint}`,
    ),
  ].join("\n");
}
