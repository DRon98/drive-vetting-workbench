import { createHash } from "node:crypto";
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
import {
  assertGoogleAuthorizationMode,
  type GoogleAuthorizationMode,
} from "./oauth.js";
import {
  GOOGLE_FILE_FIELDS,
  GOOGLE_LIST_FIELDS,
  GOOGLE_SHORTCUT_MIME_TYPE,
  type GoogleDriveApi,
  type GoogleDriveFile,
  type GoogleDriveRequestMethod,
  type GoogleExportData,
} from "./types.js";

export interface GoogleReadRetryOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxReadRetries: number;
  readonly random: () => number;
  readonly sleep: (delayMs: number) => Promise<void>;
}

export interface GoogleDriveProviderOptions {
  readonly api: GoogleDriveApi;
  readonly authorizationMode: GoogleAuthorizationMode;
  readonly retry?: Partial<GoogleReadRetryOptions>;
  readonly scanGeneration?: string;
  readonly sharedDriveId?: string | null;
}

export type GoogleReadOnlyProviderBundle = {
  readonly authorizationMode: "content" | "metadata";
  readonly read: ReadProvider;
};

export type GoogleApplyProviderBundle = {
  readonly authorizationMode: "apply";
  readonly mutation: MutationProvider;
  readonly read: ReadProvider;
};

export type GoogleDriveProviderBundle =
  GoogleApplyProviderBundle | GoogleReadOnlyProviderBundle;

interface GoogleErrorDetails {
  readonly reason: string | null;
  readonly status: number | null;
  readonly systemCode: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success<Value>(value: Value): ProviderResult<Value> {
  return { ok: true, value };
}

function failure<Value>(error: ProviderError): ProviderResult<Value> {
  return { error, ok: false };
}

function providerError(
  code: ProviderError["code"],
  itemId: string | null,
  message: string,
  retryable: boolean,
): ProviderError {
  return { code, itemId, message, retryable };
}

function errorDetails(error: unknown): GoogleErrorDetails {
  if (!isRecord(error)) {
    return { reason: null, status: null, systemCode: null };
  }
  const response = isRecord(error.response) ? error.response : null;
  const data =
    response !== null && isRecord(response.data) ? response.data : null;
  const bodyError = data !== null && isRecord(data.error) ? data.error : null;
  const errors =
    bodyError !== null && Array.isArray(bodyError.errors)
      ? bodyError.errors
      : [];
  const firstError = errors.find(isRecord);
  const responseStatus = response?.status;
  const directCode = error.code;
  return {
    reason:
      firstError !== undefined && typeof firstError.reason === "string"
        ? firstError.reason
        : null,
    status:
      typeof responseStatus === "number"
        ? responseStatus
        : typeof directCode === "number"
          ? directCode
          : null,
    systemCode: typeof directCode === "string" ? directCode : null,
  };
}

function mapGoogleError(error: unknown, itemId: string | null): ProviderError {
  const details = errorDetails(error);
  if (
    details.status === 429 ||
    details.reason === "rateLimitExceeded" ||
    details.reason === "userRateLimitExceeded"
  ) {
    return providerError(
      "RATE_LIMITED",
      itemId,
      "Google Drive rate limiting prevented the request.",
      true,
    );
  }
  if (
    details.reason === "fileNotExportable" ||
    details.reason === "fileNotDownloadable"
  ) {
    return providerError(
      "UNSUPPORTED_EXPORT",
      itemId,
      "Google Drive cannot export the requested item type.",
      false,
    );
  }
  if (details.status === 404) {
    return providerError(
      "NOT_FOUND",
      itemId,
      "Google Drive did not return the requested item.",
      false,
    );
  }
  if (details.status === 401 || details.status === 403) {
    return providerError(
      "DENIED",
      itemId,
      "Google Drive denied the requested operation.",
      false,
    );
  }
  if (details.status === 409 || details.status === 412) {
    return providerError(
      "STALE_STATE",
      itemId,
      "Google Drive state no longer matches the approved precondition.",
      false,
    );
  }
  const retryableSystemCodes = new Set([
    "ECONNRESET",
    "ENETUNREACH",
    "ETIMEDOUT",
  ]);
  const retryable =
    (details.status !== null && details.status >= 500) ||
    (details.systemCode !== null &&
      retryableSystemCodes.has(details.systemCode));
  return providerError(
    "PROVIDER_FAILURE",
    itemId,
    retryable
      ? "Google Drive returned a transient provider failure."
      : "Google Drive could not complete the request.",
    retryable,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function mapObservedItem(
  file: GoogleDriveFile,
  scanGeneration: string,
): ObservedItem | null {
  const parents: unknown = file.parents ?? [];
  if (
    !nonEmptyString(file.id) ||
    !nonEmptyString(file.mimeType) ||
    !nonEmptyString(file.createdTime) ||
    !nonEmptyString(file.modifiedTime) ||
    typeof file.name !== "string" ||
    typeof file.trashed !== "boolean" ||
    !isNonEmptyStringArray(parents)
  ) {
    return null;
  }
  const canRead = file.capabilities?.canDownload !== false;
  const canWrite =
    file.capabilities?.canRename === true ||
    file.capabilities?.canAddChildren === true;
  const permissions: ObservedItem["permissions"] = canWrite
    ? { canRead, canWrite }
    : {
        canRead,
        canWrite,
        deniedReason: "Google Drive reports no allowed write capability.",
      };
  const contentFingerprint = nonEmptyString(file.sha256Checksum)
    ? `sha256:${file.sha256Checksum}`
    : nonEmptyString(file.md5Checksum)
      ? `md5:${file.md5Checksum}`
      : null;
  return {
    contentFingerprint,
    createdTime: file.createdTime,
    id: file.id,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    name: file.name,
    parentIds: [...parents],
    permissions,
    scanGeneration,
    shortcutTargetId: nonEmptyString(file.shortcutDetails?.targetId)
      ? file.shortcutDetails.targetId
      : null,
    trashed: file.trashed,
  };
}

function mapMutationResult(file: GoogleDriveFile): MutationResult | null {
  if (
    !nonEmptyString(file.id) ||
    !nonEmptyString(file.modifiedTime) ||
    typeof file.name !== "string" ||
    !isNonEmptyStringArray(file.parents)
  ) {
    return null;
  }
  return {
    id: file.id,
    modifiedTime: file.modifiedTime,
    name: file.name,
    parentIds: [...file.parents],
    shortcutTargetId: nonEmptyString(file.shortcutDetails?.targetId)
      ? file.shortcutDetails.targetId
      : null,
  };
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

function retryOptions(
  overrides: Partial<GoogleReadRetryOptions> = {},
): GoogleReadRetryOptions {
  const options: GoogleReadRetryOptions = {
    baseDelayMs: overrides.baseDelayMs ?? 250,
    maxDelayMs: overrides.maxDelayMs ?? 4_000,
    maxReadRetries: overrides.maxReadRetries ?? 3,
    random: overrides.random ?? Math.random,
    sleep: overrides.sleep ?? defaultSleep,
  };
  if (
    !Number.isSafeInteger(options.baseDelayMs) ||
    options.baseDelayMs < 0 ||
    !Number.isSafeInteger(options.maxDelayMs) ||
    options.maxDelayMs < options.baseDelayMs ||
    !Number.isSafeInteger(options.maxReadRetries) ||
    options.maxReadRetries < 0
  ) {
    throw new RangeError("Google read retry options are invalid.");
  }
  return options;
}

function escapeDriveQueryValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

class GoogleReadProvider implements ReadProvider {
  readonly capability = "read" as const;

  readonly #api: GoogleDriveApi;
  readonly #authorizationMode: GoogleAuthorizationMode;
  readonly #retry: GoogleReadRetryOptions;
  readonly #scanGeneration: string;
  readonly #sharedDriveId: string | null;

  public constructor(options: GoogleDriveProviderOptions) {
    this.#api = options.api;
    this.#authorizationMode = options.authorizationMode;
    this.#retry = retryOptions(options.retry);
    this.#scanGeneration = options.scanGeneration ?? "google-live";
    this.#sharedDriveId = options.sharedDriveId ?? null;
  }

  async #safeRead<Value>(
    operation: () => Promise<Value>,
    itemId: string | null,
  ): Promise<ProviderResult<Value>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return success(await operation());
      } catch (error) {
        const mapped = mapGoogleError(error, itemId);
        if (!mapped.retryable || attempt >= this.#retry.maxReadRetries) {
          return failure(mapped);
        }
        const exponential = Math.min(
          this.#retry.maxDelayMs,
          this.#retry.baseDelayMs * 2 ** attempt,
        );
        const jitter = Math.floor(
          this.#retry.random() * this.#retry.baseDelayMs,
        );
        await this.#retry.sleep(
          Math.min(this.#retry.maxDelayMs, exponential + jitter),
        );
      }
    }
  }

  public async listItems(
    request: ListItemsRequest,
  ): Promise<ProviderResult<ListItemsPage>> {
    if (
      !request.supportsAllDrives ||
      !Number.isSafeInteger(request.pageSize) ||
      request.pageSize < 1 ||
      request.pageSize > 1_000
    ) {
      return failure(
        providerError(
          "PROVIDER_FAILURE",
          request.rootId,
          "The Google Drive list request is invalid.",
          false,
        ),
      );
    }
    const page = await this.#safeRead(
      () =>
        this.#api.files.list({
          corpora: this.#sharedDriveId === null ? "user" : "drive",
          ...(this.#sharedDriveId === null
            ? {}
            : { driveId: this.#sharedDriveId }),
          fields: GOOGLE_LIST_FIELDS,
          includeItemsFromAllDrives: true,
          pageSize: request.pageSize,
          ...(request.pageToken === null
            ? {}
            : { pageToken: request.pageToken }),
          q: `'${escapeDriveQueryValue(request.rootId)}' in parents`,
          spaces: "drive",
          supportsAllDrives: true,
        }),
      request.rootId,
    );
    if (!page.ok) return page;
    if (page.value.data.incompleteSearch === true) {
      return failure(
        providerError(
          "PROVIDER_FAILURE",
          request.rootId,
          "Google Drive reported an incomplete search.",
          false,
        ),
      );
    }
    const items: ObservedItem[] = [];
    for (const file of page.value.data.files ?? []) {
      const mapped = mapObservedItem(file, this.#scanGeneration);
      if (mapped === null) {
        return failure(
          providerError(
            "PROVIDER_FAILURE",
            request.rootId,
            "Google Drive returned incomplete file metadata.",
            false,
          ),
        );
      }
      items.push(mapped);
    }
    return success({
      items,
      nextPageToken: page.value.data.nextPageToken ?? null,
    });
  }

  public async getItem(
    itemId: string,
  ): Promise<ProviderResult<ObservedItem | null>> {
    const response = await this.#safeRead(
      () =>
        this.#api.files.get({
          fields: GOOGLE_FILE_FIELDS,
          fileId: itemId,
          supportsAllDrives: true,
        }),
      itemId,
    );
    if (!response.ok) {
      return response.error.code === "NOT_FOUND"
        ? success(null)
        : failure(response.error);
    }
    const mapped = mapObservedItem(response.value.data, this.#scanGeneration);
    return mapped === null
      ? failure(
          providerError(
            "PROVIDER_FAILURE",
            itemId,
            "Google Drive returned incomplete file metadata.",
            false,
          ),
        )
      : success(mapped);
  }

  public async exportItem(
    request: ExportItemRequest,
  ): Promise<ProviderResult<ExportedContent>> {
    if (this.#authorizationMode === "metadata") {
      return failure(
        providerError(
          "DENIED",
          request.itemId,
          "The metadata authorization profile cannot export file content.",
          false,
        ),
      );
    }
    const response = await this.#safeRead(
      () =>
        this.#api.files.export({
          fileId: request.itemId,
          mimeType: request.exportMimeType,
        }),
      request.itemId,
    );
    if (!response.ok) return response;
    const bytes = exportBytes(response.value.data);
    return bytes === null
      ? failure(
          providerError(
            "PROVIDER_FAILURE",
            request.itemId,
            "Google Drive returned an invalid export response.",
            false,
          ),
        )
      : success({ bytes, mimeType: request.exportMimeType });
  }
}

function exportBytes(value: GoogleExportData): Uint8Array | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof value === "string") return new TextEncoder().encode(value);
  return null;
}

class GoogleMutationProvider implements MutationProvider {
  readonly capability = "mutation" as const;

  public constructor(
    private readonly api: GoogleDriveApi,
    private readonly read: ReadProvider,
  ) {}

  public async rename(
    request: RenameRequest,
  ): Promise<ProviderResult<MutationResult>> {
    const live = await this.read.getItem(request.targetId);
    if (!live.ok) return failure(live.error);
    if (live.value === null) {
      return failure(
        providerError(
          "NOT_FOUND",
          request.targetId,
          "Google Drive did not return the rename target.",
          false,
        ),
      );
    }
    if (!live.value.permissions.canWrite) {
      return failure(
        providerError(
          "DENIED",
          request.targetId,
          "Google Drive reports no allowed write capability.",
          false,
        ),
      );
    }
    if (live.value.modifiedTime !== request.expectedModifiedTime) {
      return failure(
        providerError(
          "STALE_STATE",
          request.targetId,
          "Google Drive state no longer matches the approved precondition.",
          false,
        ),
      );
    }
    try {
      const response = await this.api.files.update({
        fields: GOOGLE_FILE_FIELDS,
        fileId: request.targetId,
        requestBody: { name: request.name },
        supportsAllDrives: true,
      });
      const result = mapMutationResult(response.data);
      return result === null
        ? failure(
            providerError(
              "PROVIDER_FAILURE",
              request.targetId,
              "Google Drive returned an invalid rename response.",
              false,
            ),
          )
        : success(result);
    } catch (error) {
      return failure(mapGoogleError(error, request.targetId));
    }
  }

  public async createShortcut(
    request: CreateShortcutRequest,
  ): Promise<ProviderResult<MutationResult>> {
    try {
      const response = await this.api.files.create({
        fields: GOOGLE_FILE_FIELDS,
        requestBody: {
          mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
          name: request.name,
          parents: [request.parentId],
          shortcutDetails: { targetId: request.targetId },
        },
        supportsAllDrives: true,
      });
      const result = mapMutationResult(response.data);
      return result === null
        ? failure(
            providerError(
              "PROVIDER_FAILURE",
              request.targetId,
              "Google Drive returned an invalid shortcut response.",
              false,
            ),
          )
        : success(result);
    } catch (error) {
      return failure(mapGoogleError(error, request.targetId));
    }
  }
}

export function createGoogleDriveProviders(
  options: GoogleDriveProviderOptions,
): GoogleDriveProviderBundle {
  assertGoogleAuthorizationMode(options.authorizationMode);
  const read = new GoogleReadProvider(options);
  return options.authorizationMode === "apply"
    ? {
        authorizationMode: "apply",
        mutation: new GoogleMutationProvider(options.api, read),
        read,
      }
    : { authorizationMode: options.authorizationMode, read };
}

function redactedId(value: unknown): string | null {
  return nonEmptyString(value) ? sha256(value) : null;
}

export function redactGoogleDriveRequest(
  method: GoogleDriveRequestMethod,
  request: unknown,
): Record<string, unknown> {
  const record = isRecord(request) ? request : {};
  const common = {
    method,
    supportsAllDrives: record.supportsAllDrives === true,
  };
  if (method === "files.list") {
    return {
      ...common,
      corpora: record.corpora,
      driveIdSha256: redactedId(record.driveId),
      hasPageToken: nonEmptyString(record.pageToken),
      includeItemsFromAllDrives: record.includeItemsFromAllDrives === true,
      pageSize: record.pageSize,
      parentQuerySha256: redactedId(record.q),
    };
  }
  const requestBody = isRecord(record.requestBody) ? record.requestBody : {};
  const parents = Array.isArray(requestBody.parents) ? requestBody.parents : [];
  const shortcutDetails = isRecord(requestBody.shortcutDetails)
    ? requestBody.shortcutDetails
    : {};
  return {
    ...common,
    fileIdSha256: redactedId(record.fileId),
    mimeType: method === "files.export" ? record.mimeType : undefined,
    nameSha256: redactedId(requestBody.name),
    parentIdSha256: redactedId(parents[0]),
    targetIdSha256: redactedId(shortcutDetails.targetId),
  };
}
