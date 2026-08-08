import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const REQUIRED_PUBLIC_DOCS = Object.freeze([
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/dependency-licenses.md",
  "docs/drive-lab.md",
  "docs/mcp-hosts.md",
  "docs/policy-packs.md",
  "docs/provider-guide.md",
  "docs/quickstart.md",
  "docs/review-workflow.md",
]);

const ignoredDirectories = new Set([
  ".git",
  ".dvw",
  "artifacts",
  "dist",
  "node_modules",
]);

function markdownFiles(root) {
  const files = [];
  for (const name of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    const path = resolve(root, name);
    if (existsSync(path)) files.push(path);
  }
  const docsRoot = resolve(root, "docs");
  if (!existsSync(docsRoot)) return files;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name))
          visit(resolve(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(resolve(directory, entry.name));
      }
    }
  };
  visit(docsRoot);
  return files.sort();
}

function githubSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function headings(markdown) {
  const values = new Set();
  const counts = new Map();
  for (const line of markdown.split(/\r?\n/u)) {
    const match = /^(?: {0,3})#{1,6}\s+(.+?)\s*#*$/u.exec(line);
    if (match === null) continue;
    const base = githubSlug(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    values.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  return values;
}

function displayPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function linkIssues(root, sourcePath, markdown) {
  const issues = [];
  const sourceDisplay = displayPath(root, sourcePath);
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of markdown.matchAll(pattern)) {
    const rawTarget = match[1]?.trim().replace(/^<|>$/gu, "");
    if (
      rawTarget === undefined ||
      rawTarget === "" ||
      /^(?:https?:|mailto:)/iu.test(rawTarget)
    ) {
      continue;
    }
    const targetWithoutTitle = rawTarget.split(/\s+["']/u, 1)[0] ?? rawTarget;
    const [rawFile = "", rawAnchor] = targetWithoutTitle.split("#", 2);
    let filePart;
    try {
      filePart = decodeURIComponent(rawFile);
    } catch {
      issues.push(
        `${sourceDisplay}: link target is not valid UTF-8: ${rawTarget}`,
      );
      continue;
    }
    const targetPath =
      filePart === "" ? sourcePath : resolve(dirname(sourcePath), filePart);
    const relativeTarget = relative(root, targetPath);
    if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === "..") {
      issues.push(`${sourceDisplay}: link leaves the repository: ${rawTarget}`);
      continue;
    }
    if (!existsSync(targetPath)) {
      issues.push(`${sourceDisplay}: link target does not exist: ${rawTarget}`);
      continue;
    }
    if (rawAnchor !== undefined) {
      if (!statSync(targetPath).isFile()) {
        issues.push(
          `${sourceDisplay}: anchor target is not a file: ${rawTarget}`,
        );
        continue;
      }
      const targetHeadings = headings(readFileSync(targetPath, "utf8"));
      if (!targetHeadings.has(rawAnchor.toLowerCase())) {
        issues.push(`${sourceDisplay}: anchor does not exist: ${rawTarget}`);
      }
    }
  }
  return issues;
}

function documentedCommandIssues(root, sourcePath, markdown, scripts) {
  const issues = [];
  const sourceDisplay = displayPath(root, sourcePath);
  const blocks = markdown.matchAll(/```(?:bash|sh|shell)\s*\n([\s\S]*?)```/gu);
  const builtIns = new Set(["add", "audit", "exec", "install", "pack", "run"]);
  for (const block of blocks) {
    for (const originalLine of (block[1] ?? "").split(/\r?\n/u)) {
      const line = originalLine.trim();
      if (!line.startsWith("pnpm ")) continue;
      const tokens = line.split(/\s+/u);
      let command = tokens[1];
      if (command === "run") command = tokens[2];
      if (
        command === undefined ||
        command.startsWith("-") ||
        builtIns.has(command) ||
        Object.hasOwn(scripts, command)
      ) {
        continue;
      }
      issues.push(
        `${sourceDisplay}: root package script does not exist: ${command}`,
      );
    }
  }
  return issues;
}

export function checkDocumentation(root) {
  const packagePath = resolve(root, "package.json");
  const packageJson = existsSync(packagePath)
    ? JSON.parse(readFileSync(packagePath, "utf8"))
    : {};
  const scripts = packageJson.scripts ?? {};
  const issues = [];
  for (const path of markdownFiles(root)) {
    const markdown = readFileSync(path, "utf8");
    issues.push(...linkIssues(root, path, markdown));
    issues.push(...documentedCommandIssues(root, path, markdown, scripts));
  }
  return issues.sort();
}

function isMain() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMain()) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const missing = REQUIRED_PUBLIC_DOCS.filter(
    (path) => !existsSync(resolve(root, path)),
  ).map((path) => `Required public document is missing: ${path}`);
  const issues = [...missing, ...checkDocumentation(root)].sort();
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`${issue}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `documentation check passed (${String(markdownFiles(root).length)} Markdown files)\n`,
    );
  }
}
