export const GOOGLE_SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

export const GOOGLE_FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "parents",
  "createdTime",
  "modifiedTime",
  "trashed",
  "driveId",
  "md5Checksum",
  "sha256Checksum",
  "shortcutDetails(targetId)",
  "capabilities(canAddChildren,canDownload,canRename)",
].join(",");

export const GOOGLE_LIST_FIELDS = `nextPageToken,incompleteSearch,files(${GOOGLE_FILE_FIELDS})`;

export interface GoogleDriveFile {
  readonly capabilities?: {
    readonly canAddChildren?: boolean | null;
    readonly canDownload?: boolean | null;
    readonly canRename?: boolean | null;
  } | null;
  readonly createdTime?: string | null;
  readonly driveId?: string | null;
  readonly id?: string | null;
  readonly md5Checksum?: string | null;
  readonly mimeType?: string | null;
  readonly modifiedTime?: string | null;
  readonly name?: string | null;
  readonly parents?: readonly string[] | null;
  readonly sha256Checksum?: string | null;
  readonly shortcutDetails?: {
    readonly targetId?: string | null;
  } | null;
  readonly trashed?: boolean | null;
}

export interface GoogleDriveFileList {
  readonly files?: readonly GoogleDriveFile[] | null;
  readonly incompleteSearch?: boolean | null;
  readonly nextPageToken?: string | null;
}

export interface GoogleApiResponse<Value> {
  readonly data: Value;
}

export interface GoogleFilesListRequest {
  readonly corpora: "drive" | "user";
  readonly driveId?: string;
  readonly fields: string;
  readonly includeItemsFromAllDrives: boolean;
  readonly pageSize: number;
  readonly pageToken?: string;
  readonly q: string;
  readonly spaces: "drive";
  readonly supportsAllDrives: boolean;
}

export interface GoogleFilesGetRequest {
  readonly fields: string;
  readonly fileId: string;
  readonly supportsAllDrives: boolean;
}

export interface GoogleFilesExportRequest {
  readonly fileId: string;
  readonly mimeType: string;
}

export interface GoogleFilesUpdateRequest {
  readonly fields: string;
  readonly fileId: string;
  readonly requestBody: { readonly name: string };
  readonly supportsAllDrives: boolean;
}

export interface GoogleFilesCreateRequest {
  readonly fields: string;
  readonly requestBody: {
    readonly mimeType: typeof GOOGLE_SHORTCUT_MIME_TYPE;
    readonly name: string;
    readonly parents: [string];
    readonly shortcutDetails: { readonly targetId: string };
  };
  readonly supportsAllDrives: boolean;
}

export type GoogleExportData = ArrayBuffer | Uint8Array | string;

export interface GoogleDriveFilesApi {
  create(
    request: GoogleFilesCreateRequest,
  ): Promise<GoogleApiResponse<GoogleDriveFile>>;
  export(
    request: GoogleFilesExportRequest,
  ): Promise<GoogleApiResponse<GoogleExportData>>;
  get(
    request: GoogleFilesGetRequest,
  ): Promise<GoogleApiResponse<GoogleDriveFile>>;
  list(
    request: GoogleFilesListRequest,
  ): Promise<GoogleApiResponse<GoogleDriveFileList>>;
  update(
    request: GoogleFilesUpdateRequest,
  ): Promise<GoogleApiResponse<GoogleDriveFile>>;
}

export interface GoogleDriveApi {
  readonly files: GoogleDriveFilesApi;
}

export type GoogleDriveRequestMethod =
  "files.create" | "files.export" | "files.get" | "files.list" | "files.update";
