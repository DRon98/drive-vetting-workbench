import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";

export const REVIEWED_LICENSES = new Set([
  "Apache-2.0",
  "BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
]);

export function auditLicenseReport(report, reviewed = REVIEWED_LICENSES) {
  const issues = [];
  for (const [license, packages] of Object.entries(report).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (reviewed.has(license)) continue;
    const packageList = packages
      .map((entry) => `${entry.name}@${entry.versions.join(",")}`)
      .sort()
      .join(", ");
    issues.push(`Unreviewed dependency license ${license}: ${packageList}`);
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
  const output = execFileSync("pnpm", ["licenses", "list", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const report = JSON.parse(output);
  const issues = auditLicenseReport(report);
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`${issue}\n`);
    process.exitCode = 1;
  } else {
    const summary = Object.fromEntries(
      Object.entries(report)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([license, packages]) => [license, packages.length]),
    );
    process.stdout.write(
      `dependency license check passed ${JSON.stringify(summary)}\n`,
    );
  }
}
