import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { z } from "zod";
import {
  LabManifestSchema,
  type LabManifest,
  type ScenarioSeed,
} from "./types.js";

const StateFileSchema = z.string().regex(/^states\/state-[a-f0-9]{64}\.json$/u);
const LedgerEventSchema = z.strictObject({
  operation: z.string().min(1),
  sequence: z.number().int().positive(),
  stateFile: StateFileSchema,
  stateHash: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.literal(1),
});
type LedgerEvent = z.infer<typeof LedgerEventSchema>;

export class DriveLabError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DriveLabError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalManifestJson(manifest: LabManifest): string {
  return `${JSON.stringify(canonicalValue(manifest), null, 2)}\n`;
}

function fileErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function assertNoSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new DriveLabError(
      "SYMLINK_ESCAPE",
      `Drive Lab refuses symlink path ${path}.`,
    );
  }
}

export function resolveSandboxPath(
  rootInput: string,
  relativePath: string,
): string {
  if (
    rootInput.trim().length === 0 ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new DriveLabError(
      "PATH_ESCAPE",
      "Drive Lab path must stay inside the sandbox root.",
    );
  }
  const root = resolve(rootInput);
  const candidate = resolve(root, relativePath);
  const fromRoot = relative(root, candidate);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new DriveLabError(
      "PATH_ESCAPE",
      "Drive Lab path escapes the sandbox root.",
    );
  }
  if (existsSync(root)) {
    assertNoSymlink(root);
    const realRoot = realpathSync(root);
    const ancestor = nearestExistingAncestor(candidate);
    assertNoSymlink(ancestor);
    const realAncestor = realpathSync(ancestor);
    const fromRealRoot = relative(realRoot, realAncestor);
    if (fromRealRoot.startsWith("..") || isAbsolute(fromRealRoot)) {
      throw new DriveLabError(
        "SYMLINK_ESCAPE",
        "Drive Lab path resolves outside the sandbox root.",
      );
    }
  }
  return candidate;
}

function prepareRoot(rootInput: string, initialize: boolean): string {
  const root = resolve(rootInput);
  if (root === parse(root).root) {
    throw new DriveLabError(
      "UNSAFE_ROOT",
      "Drive Lab refuses a filesystem root sandbox.",
    );
  }
  const ancestor = nearestExistingAncestor(root);
  assertNoSymlink(ancestor);
  if (existsSync(root)) {
    assertNoSymlink(root);
    if (!lstatSync(root).isDirectory()) {
      throw new DriveLabError(
        "INVALID_ROOT",
        "Drive Lab sandbox must be a directory.",
      );
    }
    if (initialize && readdirSync(root).length > 0) {
      throw new DriveLabError(
        "ROOT_NOT_EMPTY",
        "Drive Lab initialization needs an empty sandbox root.",
      );
    }
  } else {
    if (!initialize)
      throw new DriveLabError(
        "NOT_INITIALIZED",
        "Drive Lab is not initialized.",
      );
    mkdirSync(root, { mode: 0o700, recursive: true });
  }
  const canonicalRoot = realpathSync(root);
  const statesPath = resolveSandboxPath(canonicalRoot, "states");
  const blobsPath = resolveSandboxPath(canonicalRoot, "blobs");
  if (initialize) {
    mkdirSync(statesPath, { mode: 0o700, recursive: true });
    mkdirSync(blobsPath, { mode: 0o700, recursive: true });
  } else if (!existsSync(statesPath) || !existsSync(blobsPath)) {
    throw new DriveLabError(
      "CORRUPT_LAB",
      "Drive Lab state directories are missing.",
    );
  }
  assertNoSymlink(statesPath);
  assertNoSymlink(blobsPath);
  return canonicalRoot;
}

function writeCreateOnly(path: string, contents: string): void {
  try {
    writeFileSync(path, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      fileErrorCode(error) !== "EEXIST" ||
      readFileSync(path, "utf8") !== contents
    ) {
      throw error;
    }
  }
}

export class LabStorage {
  public readonly root: string;
  readonly #ledgerPath: string;

  private constructor(root: string) {
    this.root = root;
    this.#ledgerPath = resolveSandboxPath(root, "lab-ledger.ndjson");
  }

  public static initialize(rootInput: string, seed: ScenarioSeed): LabStorage {
    const storage = new LabStorage(prepareRoot(rootInput, true));
    for (const [hash, text] of Object.entries(seed.blobs)) {
      storage.writeBlobWithHash(hash, text);
    }
    storage.persist(seed.manifest, "INIT");
    return storage;
  }

  public static open(rootInput: string): LabStorage {
    const storage = new LabStorage(prepareRoot(rootInput, false));
    if (!existsSync(storage.#ledgerPath)) {
      throw new DriveLabError(
        "NOT_INITIALIZED",
        "Drive Lab ledger is missing.",
      );
    }
    storage.loadCurrent();
    return storage;
  }

  public persist(manifestInput: LabManifest, operation: string): string {
    const manifest = LabManifestSchema.parse(manifestInput);
    const json = canonicalManifestJson(manifest);
    const stateHash = createHash("sha256").update(json).digest("hex");
    const stateFile = `states/state-${stateHash}.json`;
    writeCreateOnly(resolveSandboxPath(this.root, stateFile), json);
    const events = this.readLedger();
    const event = LedgerEventSchema.parse({
      operation,
      sequence: events.length + 1,
      stateFile,
      stateHash,
      version: 1,
    });
    if (existsSync(this.#ledgerPath)) assertNoSymlink(this.#ledgerPath);
    appendFileSync(this.#ledgerPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: 0o600,
    });
    return stateHash;
  }

  public loadCurrent(): LabManifest {
    const event = this.readLedger().at(-1);
    if (event === undefined)
      throw new DriveLabError("CORRUPT_LAB", "Drive Lab ledger is empty.");
    return this.loadEvent(event);
  }

  public loadInitial(): LabManifest {
    const event = this.readLedger()[0];
    if (event === undefined)
      throw new DriveLabError("CORRUPT_LAB", "Drive Lab ledger is empty.");
    return this.loadEvent(event);
  }

  public loadByHash(hash: string): LabManifest {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new DriveLabError("INVALID_SNAPSHOT", "Snapshot hash is invalid.");
    }
    const path = resolveSandboxPath(this.root, `states/state-${hash}.json`);
    if (!existsSync(path))
      throw new DriveLabError(
        "SNAPSHOT_NOT_FOUND",
        "Snapshot is not in this lab.",
      );
    return this.readManifest(path, hash);
  }

  public stateHash(manifest: LabManifest): string {
    return createHash("sha256")
      .update(canonicalManifestJson(manifest))
      .digest("hex");
  }

  public writeBlob(text: string): string {
    const hash = createHash("sha256").update(text).digest("hex");
    this.writeBlobWithHash(hash, text);
    return hash;
  }

  public readBlob(hash: string): string {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new DriveLabError("CORRUPT_LAB", "Content blob hash is invalid.");
    }
    const path = resolveSandboxPath(this.root, `blobs/${hash}.txt`);
    if (!existsSync(path))
      throw new DriveLabError("CORRUPT_LAB", "Content blob is missing.");
    assertNoSymlink(path);
    const text = readFileSync(path, "utf8");
    const observedHash = createHash("sha256").update(text).digest("hex");
    if (observedHash !== hash)
      throw new DriveLabError(
        "CORRUPT_LAB",
        "Content blob hash does not match.",
      );
    return text;
  }

  private writeBlobWithHash(hash: string, text: string): void {
    if (createHash("sha256").update(text).digest("hex") !== hash) {
      throw new DriveLabError(
        "CORRUPT_LAB",
        "Scenario blob hash does not match content.",
      );
    }
    writeCreateOnly(resolveSandboxPath(this.root, `blobs/${hash}.txt`), text);
  }

  private readLedger(): LedgerEvent[] {
    if (!existsSync(this.#ledgerPath)) return [];
    assertNoSymlink(this.#ledgerPath);
    return readFileSync(this.#ledgerPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => LedgerEventSchema.parse(JSON.parse(line) as unknown));
  }

  private loadEvent(event: LedgerEvent): LabManifest {
    return this.readManifest(
      resolveSandboxPath(this.root, event.stateFile),
      event.stateHash,
    );
  }

  private readManifest(path: string, expectedHash: string): LabManifest {
    assertNoSymlink(path);
    const json = readFileSync(path, "utf8");
    if (createHash("sha256").update(json).digest("hex") !== expectedHash) {
      throw new DriveLabError(
        "CORRUPT_LAB",
        "Drive Lab state hash does not match.",
      );
    }
    return LabManifestSchema.parse(JSON.parse(json) as unknown);
  }
}
