import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { pathToFileURL } from "node:url";

const DESIGN_REFERENCE_NAME = ["plans", "and", "presentations"].join("-");
const DEPENDENCY_SCHEME_PATTERN = /\b(?:file|link):[^\s"'`,}]+/gu;
const MODULE_REFERENCE_PATTERNS = [
  /\bfrom\s*["'`]([^"'`]+)["'`]/gu,
  /\bimport\s*(?:\(\s*)?["'`]([^"'`]+)["'`]/gu,
  /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/gu,
];
const SCANNED_EXTENSIONS = new Set([
  ".cts",
  ".js",
  ".json",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const SKIPPED_DIRECTORIES = new Set([
  ".codebase-memory",
  ".dvw",
  ".git",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "receipts",
]);

function extractPnpmLockReferences(content, filePath) {
  const references = [];
  let importerPath = null;
  let insideImporters = false;

  for (const line of content.split(/\r?\n/u)) {
    if (line === "importers:") {
      insideImporters = true;
      continue;
    }
    if (insideImporters && /^\S/u.test(line)) {
      break;
    }
    if (!insideImporters) {
      continue;
    }

    const importerMatch = /^ {2}([^ ].*):\s*$/u.exec(line);
    if (importerMatch?.[1] !== undefined) {
      importerPath = importerMatch[1].replace(/^['"]|['"]$/gu, "");
      continue;
    }
    const dependencyMatch =
      /^\s+(?:specifier|version):\s+['"]?((?:file|link):[^\s'"]+)/u.exec(line);
    if (dependencyMatch?.[1] !== undefined && importerPath !== null) {
      references.push({
        reference: dependencyMatch[1],
        sourcePath:
          importerPath === "." ? filePath : `${importerPath}/package.json`,
      });
    }
  }

  return references;
}

function extractReferences(content, filePath) {
  const references = new Map();
  const isPnpmLockfile =
    filePath === "pnpm-lock.yaml" || filePath.endsWith("/pnpm-lock.yaml");
  const dependencyReferences = isPnpmLockfile
    ? extractPnpmLockReferences(content, filePath)
    : (content.match(DEPENDENCY_SCHEME_PATTERN) ?? []).map((reference) => ({
        reference,
        sourcePath: filePath,
      }));

  for (const candidate of dependencyReferences) {
    references.set(
      `${candidate.sourcePath}\u0000${candidate.reference}`,
      candidate,
    );
  }

  for (const pattern of MODULE_REFERENCE_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const reference = match[1];
      if (reference !== undefined) {
        references.set(`${filePath}\u0000${reference}`, {
          reference,
          sourcePath: filePath,
        });
      }
    }
  }

  return [...references.values()];
}

function isInsideWorkspace(workspaceRoot, candidatePath) {
  const displacement = relative(workspaceRoot, candidatePath);
  return (
    displacement === "" ||
    (displacement !== ".." &&
      !displacement.startsWith(`..${sep}`) &&
      !isAbsolute(displacement))
  );
}

function inspectReference(reference, filePath, options) {
  const schemeSeparator = reference.indexOf(":");
  const hasDependencyScheme =
    reference.startsWith("file:") || reference.startsWith("link:");
  const pathValue = hasDependencyScheme
    ? reference.slice(schemeSeparator + 1)
    : reference;

  if (
    pathValue.length === 0 ||
    (!hasDependencyScheme && !pathValue.startsWith("."))
  ) {
    if (
      isAbsolute(pathValue) ||
      win32.isAbsolute(pathValue) ||
      pathValue.startsWith("\\\\")
    ) {
      return "absolute path";
    }
    return null;
  }

  if (
    isAbsolute(pathValue) ||
    win32.isAbsolute(pathValue) ||
    pathValue.startsWith("\\\\")
  ) {
    return "absolute path";
  }

  const candidatePath = resolve(
    options.workspaceRoot,
    dirname(filePath),
    pathValue,
  );
  if (!isInsideWorkspace(options.workspaceRoot, candidatePath)) {
    return "workspace escape";
  }

  const canonicalPath = options.canonicalize?.(candidatePath) ?? candidatePath;
  if (!isInsideWorkspace(options.workspaceRoot, canonicalPath)) {
    return "symlink escape";
  }

  return null;
}

export function findExternalWorkspaceReferences(
  files,
  options = { workspaceRoot: "/workspace" },
) {
  const normalizedOptions = {
    canonicalize: options.canonicalize,
    workspaceRoot: resolve(options.workspaceRoot),
  };
  const findings = [];

  for (const file of files) {
    if (file.content.includes(DESIGN_REFERENCE_NAME)) {
      findings.push({
        path: file.path,
        reason: "design-reference repository",
      });
      continue;
    }

    for (const candidate of extractReferences(file.content, file.path)) {
      const reason = inspectReference(
        candidate.reference,
        candidate.sourcePath,
        normalizedOptions,
      );
      if (reason !== null) {
        findings.push({ path: file.path, reason });
        break;
      }
    }
  }

  return findings;
}

function collectFiles(directory, root) {
  if (!existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath, root));
      continue;
    }

    if (
      !entry.isFile() ||
      entry.name.includes(".test.") ||
      !SCANNED_EXTENSIONS.has(extname(entry.name))
    ) {
      continue;
    }

    files.push({
      content: readFileSync(entryPath, "utf8"),
      path: relative(root, entryPath),
    });
  }

  return files;
}

export function scanWorkspace(root) {
  const scanRoots = [".github", "apps", "packages", "scripts"];
  const files = scanRoots.flatMap((scanRoot) =>
    collectFiles(resolve(root, scanRoot), root),
  );
  const rootFiles = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.includes(".test.") &&
        SCANNED_EXTENSIONS.has(extname(entry.name)),
    )
    .map((entry) => ({
      content: readFileSync(resolve(root, entry.name), "utf8"),
      path: entry.name,
    }));

  return findExternalWorkspaceReferences([...rootFiles, ...files], {
    canonicalize: (candidatePath) =>
      existsSync(candidatePath) ? realpathSync(candidatePath) : candidatePath,
    workspaceRoot: root,
  });
}

const commandPath = process.argv[1];
const isMain =
  commandPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(commandPath)).href;

if (isMain) {
  const root = resolve(import.meta.dirname, "..");
  const findings = scanWorkspace(root);

  if (findings.length > 0) {
    throw new Error(
      `Product files reference paths outside this workspace: ${JSON.stringify(findings)}`,
    );
  }

  console.log("workspace boundary check passed");
}
