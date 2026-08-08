import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PolicyPack } from "@dvw/core";
import { PolicyPackValidationError, validatePolicyPack } from "./validation.js";

const PACK_FILES = {
  archiveRules: "archive-rules.json",
  documentTypes: "document-types.json",
  entityAliases: "entities.json",
  namingRules: "naming.json",
  precedents: "precedents.json",
  protectedItems: "protected-items.json",
  shortcutRules: "shortcut-rules.json",
  taxonomy: "taxonomy.json",
} as const;

const PACK_MANIFEST_FILE = "pack.json";
const DIGEST = /^[a-f0-9]{64}$/u;

interface PolicyPackManifest {
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly files: Readonly<Record<string, string>>;
  };
  readonly version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function parseManifest(value: unknown): PolicyPackManifest {
  const expectedFiles = Object.values(PACK_FILES).sort();
  if (
    !isRecord(value) ||
    !exactKeys(value, ["integrity", "version"]) ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    !isRecord(value.integrity)
  ) {
    throw new PolicyPackValidationError(
      "policy manifest integrity metadata is invalid",
    );
  }
  const integrity = value.integrity;
  if (
    !exactKeys(integrity, ["algorithm", "files"]) ||
    integrity.algorithm !== "sha256" ||
    !isRecord(integrity.files)
  ) {
    throw new PolicyPackValidationError(
      "policy manifest integrity metadata is invalid",
    );
  }
  const files = integrity.files;
  if (
    !exactKeys(files, expectedFiles) ||
    expectedFiles.some(
      (filename) =>
        typeof files[filename] !== "string" || !DIGEST.test(files[filename]),
    )
  ) {
    throw new PolicyPackValidationError(
      "policy manifest integrity metadata is invalid",
    );
  }
  return {
    integrity: {
      algorithm: "sha256",
      files: Object.fromEntries(
        expectedFiles.map((filename) => [filename, files[filename] as string]),
      ),
    },
    version: value.version,
  };
}

async function readText(root: string, filename: string): Promise<string> {
  try {
    return await readFile(join(root, filename), "utf8");
  } catch {
    throw new PolicyPackValidationError(
      `cannot read policy section ${filename}`,
    );
  }
}

function parseJson(filename: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PolicyPackValidationError(
      `cannot parse policy section ${filename}`,
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function loadPolicyPack(root: string): Promise<PolicyPack> {
  const manifestText = await readText(root, PACK_MANIFEST_FILE);
  const manifest = parseManifest(parseJson(PACK_MANIFEST_FILE, manifestText));
  const sections = await Promise.all(
    Object.entries(PACK_FILES).map(async ([key, filename]) => {
      const text = await readText(root, filename);
      if (sha256(text) !== manifest.integrity.files[filename]) {
        throw new PolicyPackValidationError(
          `policy section integrity mismatch: ${filename}`,
        );
      }
      return [key, parseJson(filename, text)] as const;
    }),
  );
  const values = Object.fromEntries(sections) as Record<
    keyof typeof PACK_FILES,
    unknown
  >;

  return validatePolicyPack({
    archiveRules: values.archiveRules,
    documentTypes: values.documentTypes,
    entityAliases: values.entityAliases,
    namingRules: values.namingRules,
    precedents: values.precedents,
    protectedItems: values.protectedItems,
    shortcutRules: values.shortcutRules,
    taxonomy: values.taxonomy,
    version: manifest.version,
  });
}
