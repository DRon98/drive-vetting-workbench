import type {
  CreateShortcutRequest,
  ExportedContent,
  ExportItemRequest,
  ListItemsPage,
  ListItemsRequest,
  MutationProvider,
  MutationResult,
  ObservedItem,
  ProviderError,
  ProviderResult,
  ReadProvider,
  RenameRequest,
} from "@dvw/core";
import { scenarioSeed } from "./scenarios.js";
import { DriveLabError, LabStorage } from "./storage.js";
import {
  LabEditSchema,
  LabManifestSchema,
  type LabDiffEntry,
  type LabEdit,
  type LabManifest,
  type LabMutationRequest,
  type LabNode,
  type LabProviderCall,
  type LabProviderMethod,
  type LabScenarioName,
  type LabSnapshot,
  type LabTreeEntry,
} from "./types.js";

const FolderMimeType = "application/vnd.google-apps.folder";
const ShortcutMimeType = "application/vnd.google-apps.shortcut";

function success<Value>(value: Value): ProviderResult<Value> {
  return { ok: true, value };
}

function failure<Value>(error: ProviderError): ProviderResult<Value> {
  return { error, ok: false };
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function item(node: LabNode, manifest: LabManifest): ObservedItem {
  return {
    contentFingerprint: node.contentFingerprint,
    createdTime: node.createdTime,
    id: node.id,
    mimeType: node.mimeType,
    modifiedTime: node.modifiedTime,
    name: node.name,
    parentIds: [...node.parentIds],
    permissions: { ...node.permissions },
    scanGeneration: `lab:${manifest.scenario}:${manifest.clockTick}`,
    shortcutTargetId: node.shortcutTargetId,
    trashed: false,
  };
}

function mutationResult(node: LabNode): MutationResult {
  return {
    id: node.id,
    modifiedTime: node.modifiedTime,
    name: node.name,
    parentIds: [...node.parentIds],
    shortcutTargetId: node.shortcutTargetId,
  };
}

function tickTime(manifest: LabManifest, tick: number): string {
  return new Date(Date.parse(manifest.clockStart) + tick * 1000).toISOString();
}

function sortedNodes(manifest: LabManifest): LabNode[] {
  return [...manifest.nodes].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function reachableNodes(manifest: LabManifest, rootId: string): LabNode[] {
  if (!manifest.nodes.some((node) => node.id === rootId)) return [];
  const reachable = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of manifest.nodes) {
      if (
        !reachable.has(node.id) &&
        node.parentIds.some((parentId) => reachable.has(parentId))
      ) {
        reachable.add(node.id);
        changed = true;
      }
    }
  }
  return sortedNodes(manifest).filter(
    (node) => node.id !== rootId && reachable.has(node.id),
  );
}

interface PageToken {
  readonly offset: number;
  readonly rootId: string;
  readonly stateHash: string;
  readonly version: 1;
}

function encodeToken(token: PageToken): string {
  return Buffer.from(JSON.stringify(token)).toString("base64url");
}

function decodeToken(value: string): PageToken | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.getPrototypeOf(parsed) !== Object.prototype ||
      Object.keys(parsed).sort().join(",") !==
        "offset,rootId,stateHash,version" ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("offset" in parsed) ||
      typeof parsed.offset !== "number" ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      !("rootId" in parsed) ||
      typeof parsed.rootId !== "string" ||
      !("stateHash" in parsed) ||
      typeof parsed.stateHash !== "string"
    ) {
      return null;
    }
    return parsed as PageToken;
  } catch {
    return null;
  }
}

function providerError(
  code: ProviderError["code"],
  itemId: string | null,
  message: string,
  retryable = false,
): ProviderError {
  return { code, itemId, message, retryable };
}

function nodeIndex(manifest: LabManifest, id: string): number {
  return manifest.nodes.findIndex((node) => node.id === id);
}

function validateParents(
  manifest: LabManifest,
  parentIds: readonly string[],
): void {
  for (const parentId of parentIds) {
    const parent = manifest.nodes.find((node) => node.id === parentId);
    if (parent === undefined || parent.mimeType !== FolderMimeType) {
      throw new DriveLabError(
        "INVALID_PARENT",
        `Lab parent ${parentId} is not a folder.`,
      );
    }
  }
}

function createsParentCycle(
  manifest: LabManifest,
  itemId: string,
  parentIds: readonly string[],
): boolean {
  const byId = new Map(manifest.nodes.map((node) => [node.id, node]));
  const pending = [...parentIds];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === itemId) return true;
    visited.add(current);
    pending.push(...(byId.get(current)?.parentIds ?? []));
  }
  return false;
}

export class DriveLab {
  public readonly mutation: MutationProvider;
  public readonly read: ReadProvider;
  public readonly sandboxRoot: string;
  readonly #calls: LabProviderCall[] = [];
  readonly #consumedFaults = new Set<string>();
  readonly #methodCounts = new Map<LabProviderMethod, number>();
  readonly #mutationRequests: LabMutationRequest[] = [];
  readonly #storage: LabStorage;
  #writeCount = 0;

  private constructor(storage: LabStorage) {
    this.#storage = storage;
    this.sandboxRoot = storage.root;
    this.read = this.createReadProvider();
    this.mutation = this.createMutationProvider();
  }

  public static initialize(root: string, scenario: LabScenarioName): DriveLab {
    let seed;
    try {
      seed = scenarioSeed(scenario);
    } catch (error) {
      throw new DriveLabError(
        "UNKNOWN_SCENARIO",
        error instanceof Error ? error.message : "Unknown Drive Lab scenario.",
      );
    }
    return new DriveLab(LabStorage.initialize(root, seed));
  }

  public static open(root: string): DriveLab {
    return new DriveLab(LabStorage.open(root));
  }

  public get calls(): readonly LabProviderCall[] {
    return clone(this.#calls);
  }

  public get manifest(): LabManifest {
    return clone(this.#storage.loadCurrent());
  }

  public get mutationRequests(): readonly LabMutationRequest[] {
    return clone(this.#mutationRequests);
  }

  public get writeCount(): number {
    return this.#writeCount;
  }

  public snapshot(): LabSnapshot {
    const manifest = this.#storage.loadCurrent();
    return {
      hash: this.#storage.stateHash(manifest),
      manifest: clone(manifest),
    };
  }

  public baselineSnapshot(): LabSnapshot {
    const manifest = this.#storage.loadInitial();
    return {
      hash: this.#storage.stateHash(manifest),
      manifest: clone(manifest),
    };
  }

  public diff(snapshotHash: string): LabDiffEntry[] {
    const reference = this.#storage.loadByHash(snapshotHash);
    const current = this.#storage.loadCurrent();
    const referenceById = new Map(
      reference.nodes.map((entry) => [entry.id, entry]),
    );
    const currentById = new Map(
      current.nodes.map((entry) => [entry.id, entry]),
    );
    const ids = [
      ...new Set([...referenceById.keys(), ...currentById.keys()]),
    ].sort();
    return ids.flatMap((itemId): LabDiffEntry[] => {
      const before = referenceById.get(itemId);
      const after = currentById.get(itemId);
      if (before === undefined) return [{ itemId, kind: "ADDED" }];
      if (after === undefined) return [{ itemId, kind: "ABSENT_FROM_CURRENT" }];
      return JSON.stringify(before) === JSON.stringify(after)
        ? []
        : [{ itemId, kind: "CHANGED" }];
    });
  }

  public treeEntries(): LabTreeEntry[] {
    const manifest = this.#storage.loadCurrent();
    const children = new Map<string, LabNode[]>();
    for (const node of sortedNodes(manifest)) {
      for (const parentId of node.parentIds) {
        const entries = children.get(parentId) ?? [];
        entries.push(node);
        children.set(parentId, entries);
      }
    }
    const entries: LabTreeEntry[] = [];
    const visit = (id: string, depth: number, path: Set<string>) => {
      const current = manifest.nodes.find((node) => node.id === id);
      if (current === undefined) return;
      entries.push({
        depth,
        id: current.id,
        name: current.name,
        shortcutTargetId: current.shortcutTargetId,
      });
      if (path.has(id)) return;
      const nextPath = new Set(path).add(id);
      for (const child of children.get(id) ?? [])
        visit(child.id, depth + 1, nextPath);
    };
    visit(manifest.rootId, 0, new Set());
    return entries;
  }

  public tree(): string {
    return this.treeEntries()
      .map((entry) => {
        const shortcut =
          entry.shortcutTargetId === null
            ? ""
            : ` -> ${entry.shortcutTargetId}`;
        return `${"  ".repeat(entry.depth)}${entry.name} [${entry.id}]${shortcut}`;
      })
      .join("\n");
  }

  public reset(): void {
    this.#storage.persist(this.#storage.loadInitial(), "RESET");
    this.#consumedFaults.clear();
    this.#methodCounts.clear();
  }

  public applyEdit(input: LabEdit): void {
    const parsed = LabEditSchema.safeParse(input);
    if (!parsed.success)
      throw new DriveLabError("INVALID_EDIT", "Drive Lab edit is invalid.");
    const edit = parsed.data;
    const manifest = this.#storage.loadCurrent();
    const nextTick = manifest.clockTick + 1;
    const time = tickTime(manifest, nextTick);
    const nodes = manifest.nodes.map((entry) => clone(entry));
    if (edit.type === "create") {
      if (nodes.some((entry) => entry.id === edit.item.id)) {
        throw new DriveLabError(
          "DUPLICATE_ID",
          `Lab item ${edit.item.id} already exists.`,
        );
      }
      validateParents(manifest, edit.item.parentIds);
      if (
        edit.item.mimeType === ShortcutMimeType ||
        (edit.item.mimeType === FolderMimeType &&
          edit.item.content !== undefined)
      ) {
        throw new DriveLabError(
          "INVALID_EDIT",
          "Use the provider contract for shortcuts and do not attach content to folders.",
        );
      }
      const blob =
        edit.item.content === undefined
          ? null
          : this.#storage.writeBlob(edit.item.content);
      nodes.push({
        contentBlob: blob,
        contentFingerprint: blob === null ? null : `sha256:${blob}`,
        createdTime: time,
        exportMimeType:
          blob === null ? null : (edit.item.exportMimeType ?? "text/plain"),
        id: edit.item.id,
        mimeType: edit.item.mimeType,
        modifiedTime: time,
        name: edit.item.name,
        parentIds: [...edit.item.parentIds],
        permissions: { canRead: true, canWrite: true },
        readDenied: false,
        shortcutTargetId: null,
        sizeBytes:
          edit.item.content === undefined
            ? null
            : Buffer.byteLength(edit.item.content),
        trashed: false,
      });
    } else if (edit.type === "fault") {
      const faults = [
        ...manifest.faults,
        {
          error: edit.error,
          method: edit.method,
          occurrence: edit.occurrence,
        },
      ];
      this.persist(
        { ...manifest, clockTick: nextTick, faults },
        `EDIT:${edit.type}`,
      );
      return;
    } else {
      const index = nodeIndex(manifest, edit.itemId);
      if (index < 0)
        throw new DriveLabError(
          "NOT_FOUND",
          `Lab item ${edit.itemId} does not exist.`,
        );
      const current = nodes[index];
      if (current === undefined)
        throw new DriveLabError("CORRUPT_LAB", "Lab item index is invalid.");
      if (edit.type === "rename") {
        nodes[index] = { ...current, modifiedTime: time, name: edit.name };
      } else if (edit.type === "reparent") {
        if (edit.itemId === manifest.rootId) {
          throw new DriveLabError(
            "INVALID_EDIT",
            "The lab root cannot be reparented.",
          );
        }
        validateParents(manifest, edit.parentIds);
        if (createsParentCycle(manifest, edit.itemId, edit.parentIds)) {
          throw new DriveLabError(
            "INVALID_EDIT",
            "An item cannot be its own parent.",
          );
        }
        nodes[index] = {
          ...current,
          modifiedTime: time,
          parentIds: [...new Set(edit.parentIds)].sort(),
        };
      } else if (edit.type === "permission") {
        nodes[index] = {
          ...current,
          modifiedTime: time,
          permissions: {
            canRead: edit.canRead,
            canWrite: edit.canWrite,
            ...(edit.deniedReason === undefined
              ? {}
              : { deniedReason: edit.deniedReason }),
          },
          readDenied: !edit.canRead,
        };
      } else {
        if (current.mimeType === FolderMimeType) {
          throw new DriveLabError(
            "INVALID_EDIT",
            "Folder content cannot be changed.",
          );
        }
        const blob = this.#storage.writeBlob(edit.content);
        nodes[index] = {
          ...current,
          contentBlob: blob,
          contentFingerprint: `sha256:${blob}`,
          exportMimeType: edit.exportMimeType,
          modifiedTime: time,
          sizeBytes: Buffer.byteLength(edit.content),
        };
      }
    }
    this.persist(
      { ...manifest, clockTick: nextTick, nodes },
      `EDIT:${edit.type}`,
    );
  }

  private persist(manifest: LabManifest, operation: string): void {
    this.#storage.persist(LabManifestSchema.parse(manifest), operation);
  }

  private recordCall(
    method: LabProviderMethod,
    request: unknown,
  ): ProviderError | null {
    const occurrence = (this.#methodCounts.get(method) ?? 0) + 1;
    this.#methodCounts.set(method, occurrence);
    this.#calls.push({ method, request: clone(request) });
    const manifest = this.#storage.loadCurrent();
    const faultIndex = manifest.faults.findIndex(
      (fault, index) =>
        !this.#consumedFaults.has(`${index}`) &&
        fault.method === method &&
        fault.occurrence === occurrence,
    );
    if (faultIndex < 0) return null;
    this.#consumedFaults.add(`${faultIndex}`);
    return clone(
      manifest.faults[faultIndex]?.error ??
        providerError("PROVIDER_FAILURE", null, "Synthetic fault is invalid."),
    );
  }

  private createReadProvider(): ReadProvider {
    return {
      capability: "read",
      exportItem: async (
        request: ExportItemRequest,
      ): Promise<ProviderResult<ExportedContent>> => {
        await Promise.resolve();
        const injected = this.recordCall("exportItem", request);
        if (injected !== null) return failure(injected);
        const manifest = this.#storage.loadCurrent();
        const target = manifest.nodes.find(
          (node) => node.id === request.itemId,
        );
        if (target === undefined)
          return failure(
            providerError(
              "NOT_FOUND",
              request.itemId,
              "Lab item was not found.",
            ),
          );
        if (target.readDenied || !target.permissions.canRead) {
          return failure(
            providerError(
              "DENIED",
              target.id,
              target.permissions.deniedReason ?? "Lab item read is denied.",
            ),
          );
        }
        if (
          target.contentBlob === null ||
          target.exportMimeType === null ||
          target.exportMimeType !== request.exportMimeType
        ) {
          return failure(
            providerError(
              "UNSUPPORTED_EXPORT",
              target.id,
              "Lab item does not support this export type.",
            ),
          );
        }
        return success({
          bytes: new TextEncoder().encode(
            this.#storage.readBlob(target.contentBlob),
          ),
          mimeType: target.exportMimeType,
        });
      },
      getItem: async (
        itemId: string,
      ): Promise<ProviderResult<ObservedItem | null>> => {
        await Promise.resolve();
        const injected = this.recordCall("getItem", { itemId });
        if (injected !== null) return failure(injected);
        const manifest = this.#storage.loadCurrent();
        const target = manifest.nodes.find((node) => node.id === itemId);
        if (target === undefined) return success(null);
        if (target.readDenied) {
          return failure(
            providerError(
              "DENIED",
              target.id,
              target.permissions.deniedReason ?? "Lab item read is denied.",
            ),
          );
        }
        return success(item(target, manifest));
      },
      listItems: async (
        request: ListItemsRequest,
      ): Promise<ProviderResult<ListItemsPage>> => {
        await Promise.resolve();
        const injected = this.recordCall("listItems", request);
        if (injected !== null) return failure(injected);
        if (
          !request.supportsAllDrives ||
          !Number.isSafeInteger(request.pageSize) ||
          request.pageSize < 1
        ) {
          return failure(
            providerError(
              "PROVIDER_FAILURE",
              null,
              "Lab list request is invalid.",
            ),
          );
        }
        const manifest = this.#storage.loadCurrent();
        const stateHash = this.#storage.stateHash(manifest);
        const nodes = reachableNodes(manifest, request.rootId);
        if (request.rootId !== manifest.rootId) {
          return failure(
            providerError(
              "NOT_FOUND",
              request.rootId,
              "Lab root was not found.",
            ),
          );
        }
        let offset = 0;
        if (request.pageToken !== null) {
          const token = decodeToken(request.pageToken);
          if (
            token === null ||
            token.rootId !== request.rootId ||
            token.stateHash !== stateHash ||
            token.offset >= nodes.length
          ) {
            return failure(
              providerError(
                "STALE_STATE",
                null,
                "Lab page token is invalid or stale.",
              ),
            );
          }
          offset = token.offset;
        }
        const configuredBoundary = manifest.pageBoundaries.find(
          (boundary) => boundary > offset,
        );
        const end = Math.min(
          nodes.length,
          offset + request.pageSize,
          configuredBoundary ?? Number.MAX_SAFE_INTEGER,
        );
        const nextPageToken =
          end < nodes.length
            ? encodeToken({
                offset: end,
                rootId: request.rootId,
                stateHash,
                version: 1,
              })
            : null;
        return success({
          items: nodes.slice(offset, end).map((node) => item(node, manifest)),
          nextPageToken,
        });
      },
    };
  }

  private createMutationProvider(): MutationProvider {
    return {
      capability: "mutation",
      createShortcut: async (
        request: CreateShortcutRequest,
      ): Promise<ProviderResult<MutationResult>> => {
        await Promise.resolve();
        this.#mutationRequests.push({
          method: "createShortcut",
          request: clone(request),
        });
        const injected = this.recordCall("createShortcut", request);
        if (injected !== null) return failure(injected);
        if (request.name.length === 0) {
          return failure(
            providerError(
              "PROVIDER_FAILURE",
              request.targetId,
              "Shortcut name must not be empty.",
            ),
          );
        }
        const manifest = this.#storage.loadCurrent();
        const existing = manifest.nodes.find(
          (node) =>
            node.mimeType === ShortcutMimeType &&
            node.shortcutTargetId === request.targetId &&
            node.parentIds.includes(request.parentId),
        );
        if (existing !== undefined) {
          return existing.name === request.name
            ? success(mutationResult(existing))
            : failure(
                providerError(
                  "STALE_STATE",
                  existing.id,
                  "A different shortcut already exists in the destination.",
                ),
              );
        }
        const target = manifest.nodes.find(
          (node) => node.id === request.targetId,
        );
        const parent = manifest.nodes.find(
          (node) => node.id === request.parentId,
        );
        if (target === undefined)
          return failure(
            providerError(
              "NOT_FOUND",
              request.targetId,
              "Shortcut target was not found.",
            ),
          );
        if (parent === undefined || parent.mimeType !== FolderMimeType) {
          return failure(
            providerError(
              "NOT_FOUND",
              request.parentId,
              "Shortcut destination folder was not found.",
            ),
          );
        }
        if (!target.permissions.canRead || !parent.permissions.canWrite) {
          return failure(
            providerError(
              "DENIED",
              !target.permissions.canRead ? target.id : parent.id,
              "Shortcut permissions are insufficient.",
            ),
          );
        }
        const nextTick = manifest.clockTick + 1;
        const time = tickTime(manifest, nextTick);
        let shortcutSequence = manifest.nextShortcutSequence;
        let shortcutId = `lab-shortcut-${String(shortcutSequence).padStart(6, "0")}`;
        while (manifest.nodes.some((node) => node.id === shortcutId)) {
          shortcutSequence += 1;
          shortcutId = `lab-shortcut-${String(shortcutSequence).padStart(6, "0")}`;
        }
        const created: LabNode = {
          contentBlob: null,
          contentFingerprint: null,
          createdTime: time,
          exportMimeType: null,
          id: shortcutId,
          mimeType: ShortcutMimeType,
          modifiedTime: time,
          name: request.name,
          parentIds: [request.parentId],
          permissions: { canRead: true, canWrite: true },
          readDenied: false,
          shortcutTargetId: request.targetId,
          sizeBytes: null,
          trashed: false,
        };
        this.persist(
          {
            ...manifest,
            clockTick: nextTick,
            nextShortcutSequence: shortcutSequence + 1,
            nodes: [...manifest.nodes, created],
          },
          "MUTATION:CREATE_SHORTCUT",
        );
        this.#writeCount += 1;
        return success(mutationResult(created));
      },
      rename: async (
        request: RenameRequest,
      ): Promise<ProviderResult<MutationResult>> => {
        await Promise.resolve();
        this.#mutationRequests.push({
          method: "rename",
          request: clone(request),
        });
        const injected = this.recordCall("rename", request);
        if (injected !== null) return failure(injected);
        if (request.name.length === 0) {
          return failure(
            providerError(
              "PROVIDER_FAILURE",
              request.targetId,
              "Rename target name must not be empty.",
            ),
          );
        }
        const manifest = this.#storage.loadCurrent();
        const index = nodeIndex(manifest, request.targetId);
        const target = manifest.nodes[index];
        if (target === undefined)
          return failure(
            providerError(
              "NOT_FOUND",
              request.targetId,
              "Rename target was not found.",
            ),
          );
        if (!target.permissions.canWrite)
          return failure(
            providerError("DENIED", target.id, "Rename permission is denied."),
          );
        if (target.modifiedTime !== request.expectedModifiedTime) {
          return failure(
            providerError(
              "STALE_STATE",
              target.id,
              "Rename precondition is stale.",
            ),
          );
        }
        const nextTick = manifest.clockTick + 1;
        const changed = {
          ...target,
          modifiedTime: tickTime(manifest, nextTick),
          name: request.name,
        };
        const nodes = manifest.nodes.map((node, nodePosition) =>
          nodePosition === index ? changed : node,
        );
        this.persist(
          { ...manifest, clockTick: nextTick, nodes },
          "MUTATION:RENAME",
        );
        this.#writeCount += 1;
        return success(mutationResult(changed));
      },
    };
  }
}

export class DriveLabProviderSelector {
  public constructor(
    private readonly sandboxRoot: string,
    private readonly providerId = "lab",
  ) {}

  public select(input: { readonly providerId: string }): Promise<{
    readonly providerId: string;
    readonly read: ReadProvider;
  }> {
    if (input.providerId !== this.providerId) {
      throw new DriveLabError(
        "UNKNOWN_PROVIDER",
        `Drive Lab selector does not provide ${input.providerId}.`,
      );
    }
    return Promise.resolve({
      providerId: this.providerId,
      read: DriveLab.open(this.sandboxRoot).read,
    });
  }
}
