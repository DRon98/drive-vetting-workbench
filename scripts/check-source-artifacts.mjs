import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoots = ["apps", "packages"];
const generatedFilePattern =
  /(?:\.js|\.js\.map|\.d\.ts|\.d\.ts\.map|\.tsbuildinfo)$/u;

function collectGeneratedFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectGeneratedFiles(entryPath);
    }

    if (entry.isFile() && generatedFilePattern.test(entry.name)) {
      return [relative(repositoryRoot, entryPath)];
    }

    return [];
  });
}

const generatedFiles = workspaceRoots
  .flatMap((workspaceRoot) => {
    const directory = join(repositoryRoot, workspaceRoot);
    if (!existsSync(directory)) {
      return [];
    }
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        collectGeneratedFiles(join(directory, entry.name, "src")),
      );
  })
  .sort();

if (generatedFiles.length > 0) {
  console.error("Generated compiler artifacts found in source directories:");
  for (const file of generatedFiles) {
    console.error(`- ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log("source artifact check passed");
}
