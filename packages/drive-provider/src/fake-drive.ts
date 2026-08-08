import type {
  CreateShortcutRequest,
  ExportedContent,
  ExportItemRequest,
  ListItemsPage,
  ListItemsRequest,
  MutationResult,
  MutationProvider,
  ObservedItem,
  ProviderError,
  ProviderResult,
  ReadProvider,
  RenameRequest,
} from "@dvw/core";

export type FakeDriveMethod =
  "listItems" | "getItem" | "exportItem" | "rename" | "createShortcut";

export interface FakeDriveNativeExport {
  readonly mimeType: string;
  readonly text: string;
}

export interface FakeDriveFixtureItem {
  readonly item: ObservedItem;
  readonly nativeExports?: readonly FakeDriveNativeExport[];
  readonly readDenied?: boolean;
  readonly sharedDriveId?: string | null;
}

export interface FakeDriveFixture {
  readonly items: readonly FakeDriveFixtureItem[];
  readonly rootIds: readonly string[];
}

export interface FakeDriveOptions {
  readonly idFactory?: (sequence: number) => string;
  readonly now?: () => string;
}

export interface FakeDriveCall {
  readonly method: FakeDriveMethod;
  readonly request: unknown;
}

export type FakeDriveMutationRequest =
  | { readonly method: "rename"; readonly request: RenameRequest }
  | {
      readonly method: "createShortcut";
      readonly request: CreateShortcutRequest;
    };

export interface FakeDriveControls {
  advanceModifiedTime(itemId: string, modifiedTime: string): void;
  failOnCall(
    method: FakeDriveMethod,
    occurrence: number,
    error: ProviderError,
  ): void;
}

export interface InstrumentedFakeDrive {
  readonly calls: readonly FakeDriveCall[];
  readonly controls: FakeDriveControls;
  readonly mutation: MutationProvider;
  readonly mutationRequests: readonly FakeDriveMutationRequest[];
  readonly read: ReadProvider;
  readonly writeCount: number;
}

interface StoredItem {
  item: ObservedItem;
  readonly nativeExports: ReadonlyMap<string, string>;
  readonly readDenied: boolean;
  readonly sharedDriveId: string | null;
}

interface PageCursor {
  readonly offset: number;
  readonly pageSize: number;
  readonly rootId: string;
  readonly supportsAllDrives: boolean;
}

interface FailureRule {
  readonly error: ProviderError;
  readonly method: FakeDriveMethod;
  readonly occurrence: number;
  used: boolean;
}

function success<Value>(value: Value): ProviderResult<Value> {
  return { ok: true, value };
}

function failure<Value>(error: ProviderError): ProviderResult<Value> {
  return { error, ok: false };
}

function cloneError(error: ProviderError): ProviderError {
  return { ...error };
}

function cloneObservedItem(item: ObservedItem): ObservedItem {
  return {
    ...item,
    parentIds: [...item.parentIds],
    permissions: { ...item.permissions },
  };
}

function cloneMutationRequest(
  entry: FakeDriveMutationRequest,
): FakeDriveMutationRequest {
  return entry.method === "rename"
    ? { method: entry.method, request: { ...entry.request } }
    : { method: entry.method, request: { ...entry.request } };
}

function mutationResult(item: ObservedItem): MutationResult {
  return {
    id: item.id,
    modifiedTime: item.modifiedTime,
    name: item.name,
    parentIds: [...item.parentIds],
    shortcutTargetId: item.shortcutTargetId,
  };
}

function contextualError(
  code: ProviderError["code"],
  itemId: string | null,
  message: string,
  retryable = false,
): ProviderError {
  return { code, itemId, message, retryable };
}

class FakeDriveRuntime {
  readonly calls: FakeDriveCall[] = [];
  readonly mutationRequests: FakeDriveMutationRequest[] = [];
  readonly rootIds: ReadonlySet<string>;
  readonly items: Map<string, StoredItem>;
  private readonly failures: FailureRule[] = [];
  private readonly methodCounts = new Map<FakeDriveMethod, number>();
  private readonly pageCursors = new Map<string, PageCursor>();
  private readonly idFactory: (sequence: number) => string;
  private readonly now: () => string;
  private pageTokenSequence = 0;
  private shortcutSequence = 0;
  writeCount = 0;

  constructor(fixture: FakeDriveFixture, options: FakeDriveOptions) {
    this.rootIds = new Set(fixture.rootIds);
    this.items = new Map(
      fixture.items.map((fixtureItem) => [
        fixtureItem.item.id,
        {
          item: cloneObservedItem(fixtureItem.item),
          nativeExports: new Map(
            (fixtureItem.nativeExports ?? []).map((entry) => [
              entry.mimeType,
              entry.text,
            ]),
          ),
          readDenied: fixtureItem.readDenied ?? false,
          sharedDriveId: fixtureItem.sharedDriveId ?? null,
        } satisfies StoredItem,
      ]),
    );
    this.idFactory =
      options.idFactory ??
      ((sequence) => `fake-shortcut-${String(sequence).padStart(6, "0")}`);
    this.now = options.now ?? (() => "2026-01-01T00:00:00.000Z");
  }

  recordCall(method: FakeDriveMethod, request: unknown): ProviderError | null {
    const occurrence = (this.methodCounts.get(method) ?? 0) + 1;
    this.methodCounts.set(method, occurrence);
    this.calls.push({ method, request: structuredClone(request) });
    const rule = this.failures.find(
      (candidate) =>
        !candidate.used &&
        candidate.method === method &&
        candidate.occurrence === occurrence,
    );
    if (rule === undefined) {
      return null;
    }
    rule.used = true;
    return cloneError(rule.error);
  }

  recordMutation(entry: FakeDriveMutationRequest): ProviderError | null {
    this.mutationRequests.push(cloneMutationRequest(entry));
    return this.recordCall(entry.method, entry.request);
  }

  failOnCall(
    method: FakeDriveMethod,
    occurrence: number,
    error: ProviderError,
  ): void {
    if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
      throw new RangeError("Failure occurrence must be a positive integer.");
    }
    if (occurrence <= (this.methodCounts.get(method) ?? 0)) {
      throw new RangeError("Failure occurrence must select a future call.");
    }
    this.failures.push({
      error: cloneError(error),
      method,
      occurrence,
      used: false,
    });
  }

  advanceModifiedTime(itemId: string, modifiedTime: string): void {
    const stored = this.items.get(itemId);
    if (stored === undefined) {
      throw new RangeError(`Cannot change unknown fake Drive item: ${itemId}`);
    }
    stored.item = { ...stored.item, modifiedTime };
  }

  issuePageToken(cursor: PageCursor): string {
    this.pageTokenSequence += 1;
    const token = `fake-page-token-${this.pageTokenSequence}`;
    this.pageCursors.set(token, cursor);
    return token;
  }

  resolvePageToken(token: string): PageCursor | undefined {
    return this.pageCursors.get(token);
  }

  nextShortcutId(): string {
    this.shortcutSequence += 1;
    return this.idFactory(this.shortcutSequence);
  }

  currentTime(): string {
    return this.now();
  }
}

class FakeDriveReadProvider implements ReadProvider {
  readonly capability = "read" as const;

  constructor(private readonly runtime: FakeDriveRuntime) {}

  async listItems(
    request: ListItemsRequest,
  ): Promise<ProviderResult<ListItemsPage>> {
    await Promise.resolve();
    const injectedError = this.runtime.recordCall("listItems", { ...request });
    if (injectedError !== null) {
      return failure(injectedError);
    }
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1) {
      return failure(
        contextualError(
          "PROVIDER_FAILURE",
          request.rootId,
          "Page size must be a positive integer.",
        ),
      );
    }

    const scopedItems = [...this.runtime.items.values()].filter((stored) =>
      stored.item.parentIds.includes(request.rootId),
    );
    if (
      !request.supportsAllDrives &&
      scopedItems.some((stored) => stored.sharedDriveId !== null)
    ) {
      return failure(
        contextualError(
          "PROVIDER_FAILURE",
          request.rootId,
          "Shared Drive access requires supportsAllDrives.",
        ),
      );
    }

    let offset = 0;
    if (request.pageToken !== null) {
      const cursor = this.runtime.resolvePageToken(request.pageToken);
      if (
        cursor === undefined ||
        cursor.rootId !== request.rootId ||
        cursor.pageSize !== request.pageSize ||
        cursor.supportsAllDrives !== request.supportsAllDrives
      ) {
        return failure(
          contextualError(
            "PROVIDER_FAILURE",
            request.rootId,
            "The page token does not match this list request.",
          ),
        );
      }
      offset = cursor.offset;
    }

    const pageItems = scopedItems
      .slice(offset, offset + request.pageSize)
      .map((stored) => cloneObservedItem(stored.item));
    const nextOffset = offset + pageItems.length;
    const nextPageToken =
      nextOffset < scopedItems.length
        ? this.runtime.issuePageToken({
            offset: nextOffset,
            pageSize: request.pageSize,
            rootId: request.rootId,
            supportsAllDrives: request.supportsAllDrives,
          })
        : null;

    return success({ items: pageItems, nextPageToken });
  }

  async getItem(itemId: string): Promise<ProviderResult<ObservedItem | null>> {
    await Promise.resolve();
    const injectedError = this.runtime.recordCall("getItem", { itemId });
    if (injectedError !== null) {
      return failure(injectedError);
    }
    const stored = this.runtime.items.get(itemId);
    if (stored === undefined) {
      return success(null);
    }
    if (stored.readDenied) {
      return failure(
        contextualError(
          "DENIED",
          itemId,
          stored.item.permissions.deniedReason ?? "Item access is denied.",
        ),
      );
    }
    return success(cloneObservedItem(stored.item));
  }

  async exportItem(
    request: ExportItemRequest,
  ): Promise<ProviderResult<ExportedContent>> {
    await Promise.resolve();
    const injectedError = this.runtime.recordCall("exportItem", { ...request });
    if (injectedError !== null) {
      return failure(injectedError);
    }
    const stored = this.runtime.items.get(request.itemId);
    if (stored === undefined) {
      return failure(
        contextualError(
          "NOT_FOUND",
          request.itemId,
          "The export target does not exist.",
        ),
      );
    }
    if (stored.readDenied || !stored.item.permissions.canRead) {
      return failure(
        contextualError(
          "DENIED",
          request.itemId,
          stored.item.permissions.deniedReason ?? "Item export is denied.",
        ),
      );
    }
    const text = stored.nativeExports.get(request.exportMimeType);
    if (text === undefined) {
      return failure(
        contextualError(
          "UNSUPPORTED_EXPORT",
          request.itemId,
          `No synthetic export is available for ${request.exportMimeType}.`,
        ),
      );
    }
    return success({
      bytes: new TextEncoder().encode(text),
      mimeType: request.exportMimeType,
    });
  }
}

class FakeDriveMutationProvider implements MutationProvider {
  readonly capability = "mutation" as const;

  constructor(private readonly runtime: FakeDriveRuntime) {}

  async rename(
    request: RenameRequest,
  ): Promise<ProviderResult<MutationResult>> {
    await Promise.resolve();
    const injectedError = this.runtime.recordMutation({
      method: "rename",
      request: { ...request },
    });
    if (injectedError !== null) {
      return failure(injectedError);
    }
    const stored = this.runtime.items.get(request.targetId);
    if (stored === undefined) {
      return failure(
        contextualError(
          "NOT_FOUND",
          request.targetId,
          "The rename target does not exist.",
        ),
      );
    }
    if (!stored.item.permissions.canWrite) {
      return failure(
        contextualError(
          "DENIED",
          request.targetId,
          stored.item.permissions.deniedReason ?? "Rename access is denied.",
        ),
      );
    }
    if (stored.item.modifiedTime !== request.expectedModifiedTime) {
      return failure(
        contextualError(
          "STALE_STATE",
          request.targetId,
          "The item changed after it was observed.",
        ),
      );
    }

    stored.item = {
      ...stored.item,
      modifiedTime: this.runtime.currentTime(),
      name: request.name,
    };
    this.runtime.writeCount += 1;
    return success(mutationResult(stored.item));
  }

  async createShortcut(
    request: CreateShortcutRequest,
  ): Promise<ProviderResult<MutationResult>> {
    await Promise.resolve();
    const injectedError = this.runtime.recordMutation({
      method: "createShortcut",
      request: { ...request },
    });
    if (injectedError !== null) {
      return failure(injectedError);
    }
    const target = this.runtime.items.get(request.targetId);
    if (target === undefined) {
      return failure(
        contextualError(
          "NOT_FOUND",
          request.targetId,
          "The shortcut target does not exist.",
        ),
      );
    }
    const parent = this.runtime.items.get(request.parentId);
    if (parent === undefined && !this.runtime.rootIds.has(request.parentId)) {
      return failure(
        contextualError(
          "NOT_FOUND",
          request.parentId,
          "The shortcut parent does not exist.",
        ),
      );
    }
    if (parent !== undefined && !parent.item.permissions.canWrite) {
      return failure(
        contextualError(
          "DENIED",
          request.parentId,
          parent.item.permissions.deniedReason ??
            "Shortcut creation access is denied.",
        ),
      );
    }

    const id = this.runtime.nextShortcutId();
    if (this.runtime.items.has(id)) {
      return failure(
        contextualError(
          "PROVIDER_FAILURE",
          id,
          "The fake shortcut ID factory produced a duplicate ID.",
        ),
      );
    }
    const time = this.runtime.currentTime();
    const item: ObservedItem = {
      contentFingerprint: null,
      createdTime: time,
      id,
      mimeType: "application/vnd.google-apps.shortcut",
      modifiedTime: time,
      name: request.name,
      parentIds: [request.parentId],
      permissions: { canRead: true, canWrite: true },
      scanGeneration: target.item.scanGeneration,
      shortcutTargetId: request.targetId,
      trashed: false,
    };
    this.runtime.items.set(id, {
      item,
      nativeExports: new Map(),
      readDenied: false,
      sharedDriveId: parent?.sharedDriveId ?? null,
    });
    this.runtime.writeCount += 1;
    return success(mutationResult(item));
  }
}

export function createInstrumentedFakeDrive(
  fixture: FakeDriveFixture,
  options: FakeDriveOptions = {},
): InstrumentedFakeDrive {
  const runtime = new FakeDriveRuntime(fixture, options);
  const controls: FakeDriveControls = {
    advanceModifiedTime(itemId, modifiedTime) {
      runtime.advanceModifiedTime(itemId, modifiedTime);
    },
    failOnCall(method, occurrence, error) {
      runtime.failOnCall(method, occurrence, error);
    },
  };

  return {
    get calls() {
      return runtime.calls.map((call) => ({
        method: call.method,
        request: structuredClone(call.request),
      }));
    },
    controls,
    mutation: new FakeDriveMutationProvider(runtime),
    get mutationRequests() {
      return runtime.mutationRequests.map(cloneMutationRequest);
    },
    read: new FakeDriveReadProvider(runtime),
    get writeCount() {
      return runtime.writeCount;
    },
  };
}
