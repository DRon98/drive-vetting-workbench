import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createInstrumentedFakeDrive } from "../../../packages/drive-provider/src/index.js";
import {
  GOOGLE_AUTHORIZATION_SCOPES,
  GOOGLE_FILE_FIELDS,
  GOOGLE_SHORTCUT_MIME_TYPE,
  GoogleTokenStore,
  authenticateGoogleInstalledApp,
  authorizeGoogleDrive,
  createGoogleDriveProviders,
  redactGoogleDriveRequest,
  type GoogleAuthorizationCodeExchange,
  type GoogleAuthClient,
  type GoogleDriveApi,
  type GoogleDriveFile,
} from "../../../packages/drive-google/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function googleFile(overrides: Partial<GoogleDriveFile> = {}): GoogleDriveFile {
  return {
    capabilities: {
      canAddChildren: false,
      canDownload: true,
      canRename: true,
    },
    createdTime: "2026-08-08T12:00:00.000Z",
    driveId: null,
    id: "item-fixture",
    md5Checksum: null,
    mimeType: "application/pdf",
    modifiedTime: "2026-08-08T12:30:00.000Z",
    name: "Synthetic invoice.pdf",
    parents: ["root-fixture"],
    sha256Checksum: "fixture-checksum",
    shortcutDetails: null,
    trashed: false,
    ...overrides,
  };
}

function missingGoogleMethod(): Promise<never> {
  return Promise.reject(new Error("Unexpected Google API method call."));
}

function googleApi(
  overrides: Partial<GoogleDriveApi["files"]> = {},
): GoogleDriveApi {
  return {
    files: {
      create: overrides.create ?? missingGoogleMethod,
      export: overrides.export ?? missingGoogleMethod,
      get: overrides.get ?? missingGoogleMethod,
      list: overrides.list ?? missingGoogleMethod,
      update: overrides.update ?? missingGoogleMethod,
    },
  };
}

function googleError(status: number, reason: string): Error {
  return Object.assign(
    new Error("Fixture provider failure with access_token=fixture-secret"),
    {
      response: {
        data: {
          error: {
            errors: [
              {
                message:
                  "Fixture provider failure with refresh_token=fixture-secret",
                reason,
              },
            ],
            message:
              "Fixture provider failure with refresh_token=fixture-secret",
          },
        },
        status,
      },
    },
  );
}

describe("Google Drive provider offline contract", () => {
  test("matches the fake provider for read, export, rename, and shortcut results", async () => {
    const observed = {
      contentFingerprint: "sha256:fixture-checksum",
      createdTime: "2026-08-08T12:00:00.000Z",
      id: "item-fixture",
      mimeType: "application/pdf",
      modifiedTime: "2026-08-08T12:30:00.000Z",
      name: "Synthetic invoice.pdf",
      parentIds: ["root-fixture"],
      permissions: { canRead: true, canWrite: true },
      scanGeneration: "generation-contract",
      shortcutTargetId: null,
      trashed: false,
    };
    const fake = createInstrumentedFakeDrive(
      {
        items: [
          {
            item: observed,
            nativeExports: [
              { mimeType: "text/plain", text: "synthetic export" },
            ],
          },
        ],
        rootIds: ["root-fixture"],
      },
      {
        idFactory: () => "shortcut-created",
        now: () => "2026-08-08T12:31:00.000Z",
      },
    );
    const list = vi.fn<GoogleDriveApi["files"]["list"]>(() =>
      Promise.resolve({
        data: {
          files: [googleFile()],
          incompleteSearch: false,
          nextPageToken: null,
        },
      }),
    );
    const get = vi.fn<GoogleDriveApi["files"]["get"]>(() =>
      Promise.resolve({ data: googleFile() }),
    );
    const exportFile = vi.fn<GoogleDriveApi["files"]["export"]>(() =>
      Promise.resolve({
        data: new TextEncoder().encode("synthetic export"),
      }),
    );
    const update = vi.fn<GoogleDriveApi["files"]["update"]>(() =>
      Promise.resolve({
        data: googleFile({
          modifiedTime: "2026-08-08T12:31:00.000Z",
          name: "Approved invoice.pdf",
        }),
      }),
    );
    const create = vi.fn<GoogleDriveApi["files"]["create"]>(() =>
      Promise.resolve({
        data: googleFile({
          createdTime: "2026-08-08T12:31:00.000Z",
          id: "shortcut-created",
          mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
          modifiedTime: "2026-08-08T12:31:00.000Z",
          name: "Approved shortcut",
          parents: ["root-fixture"],
          sha256Checksum: null,
          shortcutDetails: { targetId: "item-fixture" },
        }),
      }),
    );
    const google = createGoogleDriveProviders({
      api: googleApi({ create, export: exportFile, get, list, update }),
      authorizationMode: "apply",
      scanGeneration: "generation-contract",
    });
    if (!("mutation" in google)) {
      throw new Error("Apply mode did not expose its mutation provider.");
    }
    const listRequest = {
      pageSize: 10,
      pageToken: null,
      rootId: "root-fixture",
      supportsAllDrives: true,
    } as const;
    const exportRequest = {
      exportMimeType: "text/plain",
      itemId: "item-fixture",
    } as const;
    const renameRequest = {
      expectedModifiedTime: "2026-08-08T12:30:00.000Z",
      name: "Approved invoice.pdf",
      targetId: "item-fixture",
    } as const;
    const shortcutRequest = {
      name: "Approved shortcut",
      parentId: "root-fixture",
      targetId: "item-fixture",
    } as const;

    expect(await google.read.listItems(listRequest)).toEqual(
      await fake.read.listItems(listRequest),
    );
    expect(await google.read.getItem("item-fixture")).toEqual(
      await fake.read.getItem("item-fixture"),
    );
    expect(await google.read.exportItem(exportRequest)).toEqual(
      await fake.read.exportItem(exportRequest),
    );
    expect(await google.mutation.rename(renameRequest)).toEqual(
      await fake.mutation.rename(renameRequest),
    );
    expect(await google.mutation.createShortcut(shortcutRequest)).toEqual(
      await fake.mutation.createShortcut(shortcutRequest),
    );
  });

  test("uses a PKCE-protected random loopback callback for installed-app consent", async () => {
    const base = temporaryDirectory("dvw-google-loopback-contract-");
    const clientCredentialsPath = join(base, "oauth", "client_secret.json");
    mkdirSync(dirname(clientCredentialsPath), { mode: 0o700 });
    writeFileSync(
      clientCredentialsPath,
      `${JSON.stringify({
        installed: {
          client_id: "fixture-client-id",
          client_secret: "fixture-client-secret",
          redirect_uris: ["http://localhost"],
        },
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const authorizationUrls: URL[] = [];
    const exchangeCode = vi.fn<GoogleAuthorizationCodeExchange>(
      (_client, input) => {
        expect(input.code).toBe("fixture-authorization-code");
        expect(input.codeVerifier.length).toBeGreaterThan(40);
        expect(input.redirectUri).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/u,
        );
        return Promise.resolve({ refreshToken: "fixture-refresh-token" });
      },
    );

    const client = await authenticateGoogleInstalledApp({
      clientCredentialsPath,
      exchangeCode,
      openBrowser: async (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        authorizationUrls.push(parsed);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        if (redirectUri === null || state === null) {
          throw new Error("The authorization URL omitted callback state.");
        }
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", "fixture-authorization-code");
        callback.searchParams.set("state", state);
        const response = await fetch(callback);
        expect(response.status).toBe(200);
      },
      scopes: GOOGLE_AUTHORIZATION_SCOPES.metadata,
      stateFactory: () => "fixture-csrf-state",
      timeoutMs: 2_000,
    });

    expect(client.credentials.refresh_token).toBe("fixture-refresh-token");
    expect(exchangeCode).toHaveBeenCalledTimes(1);
    expect(authorizationUrls).toHaveLength(1);
    const authorizationUrl = authorizationUrls[0];
    expect(authorizationUrl?.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(
      authorizationUrl?.searchParams.get("code_challenge")?.length,
    ).toBeGreaterThan(40);
    expect(authorizationUrl?.searchParams.get("include_granted_scopes")).toBe(
      "false",
    );
    expect(authorizationUrl?.searchParams.get("prompt")).toBe("consent");
    expect(authorizationUrl?.searchParams.get("state")).toBe(
      "fixture-csrf-state",
    );
  });

  test("rejects a loopback callback with mismatched CSRF state before token exchange", async () => {
    const base = temporaryDirectory("dvw-google-state-contract-");
    const clientCredentialsPath = join(base, "oauth", "client_secret.json");
    mkdirSync(dirname(clientCredentialsPath), { mode: 0o700 });
    writeFileSync(
      clientCredentialsPath,
      `${JSON.stringify({
        installed: {
          client_id: "fixture-client-id",
          client_secret: "fixture-client-secret",
        },
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const exchangeCode = vi.fn<GoogleAuthorizationCodeExchange>(() =>
      Promise.resolve({ refreshToken: "fixture-refresh-token" }),
    );

    await expect(
      authenticateGoogleInstalledApp({
        clientCredentialsPath,
        exchangeCode,
        openBrowser: async (authorizationUrl) => {
          const parsed = new URL(authorizationUrl);
          const redirectUri = parsed.searchParams.get("redirect_uri");
          if (redirectUri === null) {
            throw new Error("The authorization URL omitted its callback.");
          }
          const callback = new URL(redirectUri);
          callback.searchParams.set("code", "fixture-authorization-code");
          callback.searchParams.set("state", "wrong-fixture-state");
          const response = await fetch(callback);
          expect(response.status).toBe(400);
        },
        scopes: GOOGLE_AUTHORIZATION_SCOPES.metadata,
        stateFactory: () => "fixture-csrf-state",
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: "STATE_MISMATCH" });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  test("separates metadata, content, and apply scopes and exposes mutation only for apply", async () => {
    expect(GOOGLE_AUTHORIZATION_SCOPES).toEqual({
      apply: ["https://www.googleapis.com/auth/drive"],
      content: ["https://www.googleapis.com/auth/drive.readonly"],
      metadata: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
    });

    const api = googleApi();
    const metadata = createGoogleDriveProviders({
      api,
      authorizationMode: "metadata",
    });
    const content = createGoogleDriveProviders({
      api,
      authorizationMode: "content",
    });
    const apply = createGoogleDriveProviders({
      api,
      authorizationMode: "apply",
    });

    expect(metadata).not.toHaveProperty("mutation");
    expect(content).not.toHaveProperty("mutation");
    expect(apply).toHaveProperty("mutation");
    expect(() =>
      createGoogleDriveProviders({
        api,
        authorizationMode: "invalid-mode" as never,
      }),
    ).toThrow(/authorization mode/u);

    const metadataExport = await metadata.read.exportItem({
      exportMimeType: "text/plain",
      itemId: "item-fixture",
    });
    expect(metadataExport).toMatchObject({
      error: { code: "DENIED", retryable: false },
      ok: false,
    });
  });

  test("maps paginated Shared Drive children, shortcuts, checksums, and capabilities", async () => {
    const list = vi.fn<GoogleDriveApi["files"]["list"]>(() =>
      Promise.resolve({
        data: {
          files: [
            googleFile(),
            googleFile({
              capabilities: {
                canAddChildren: false,
                canDownload: true,
                canRename: false,
              },
              id: "shortcut-fixture",
              mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
              name: "Synthetic shortcut",
              sha256Checksum: null,
              shortcutDetails: { targetId: "item-fixture" },
            }),
          ],
          incompleteSearch: false,
          nextPageToken: "page-token-2",
        },
      }),
    );
    const provider = createGoogleDriveProviders({
      api: googleApi({ list }),
      authorizationMode: "content",
      scanGeneration: "generation-contract",
      sharedDriveId: "shared-drive-fixture",
    });

    const page = await provider.read.listItems({
      pageSize: 2,
      pageToken: "page-token-1",
      rootId: "root-fixture",
      supportsAllDrives: true,
    });

    expect(page).toEqual({
      ok: true,
      value: {
        items: [
          {
            contentFingerprint: "sha256:fixture-checksum",
            createdTime: "2026-08-08T12:00:00.000Z",
            id: "item-fixture",
            mimeType: "application/pdf",
            modifiedTime: "2026-08-08T12:30:00.000Z",
            name: "Synthetic invoice.pdf",
            parentIds: ["root-fixture"],
            permissions: { canRead: true, canWrite: true },
            scanGeneration: "generation-contract",
            shortcutTargetId: null,
            trashed: false,
          },
          {
            contentFingerprint: null,
            createdTime: "2026-08-08T12:00:00.000Z",
            id: "shortcut-fixture",
            mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
            modifiedTime: "2026-08-08T12:30:00.000Z",
            name: "Synthetic shortcut",
            parentIds: ["root-fixture"],
            permissions: {
              canRead: true,
              canWrite: false,
              deniedReason: "Google Drive reports no allowed write capability.",
            },
            scanGeneration: "generation-contract",
            shortcutTargetId: "item-fixture",
            trashed: false,
          },
        ],
        nextPageToken: "page-token-2",
      },
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      corpora: "drive",
      driveId: "shared-drive-fixture",
      includeItemsFromAllDrives: true,
      pageSize: 2,
      pageToken: "page-token-1",
      q: "'root-fixture' in parents",
      spaces: "drive",
      supportsAllDrives: true,
    });
    const redacted = redactGoogleDriveRequest(
      "files.list",
      list.mock.calls[0]?.[0] ?? {},
    );
    expect(redacted).toMatchSnapshot("redacted Shared Drive list request");
    const redactedText = JSON.stringify(redacted);
    expect(redactedText).not.toContain("root-fixture");
    expect(redactedText).not.toContain("shared-drive-fixture");
  });

  test("maps a root item without a parent edge", async () => {
    const get = vi.fn<GoogleDriveApi["files"]["get"]>(() =>
      Promise.resolve({
        data: googleFile({ id: "root-fixture", parents: null }),
      }),
    );
    const provider = createGoogleDriveProviders({
      api: googleApi({ get }),
      authorizationMode: "content",
    });

    const rootItem = await provider.read.getItem("root-fixture");

    expect(rootItem).toMatchObject({
      ok: true,
      value: { id: "root-fixture", parentIds: [] },
    });
  });

  test("fails closed when Google reports an incomplete search", async () => {
    const list = vi.fn<GoogleDriveApi["files"]["list"]>(() =>
      Promise.resolve({
        data: {
          files: [googleFile()],
          incompleteSearch: true,
          nextPageToken: null,
        },
      }),
    );
    const provider = createGoogleDriveProviders({
      api: googleApi({ list }),
      authorizationMode: "content",
    });

    const result = await provider.read.listItems({
      pageSize: 10,
      pageToken: null,
      rootId: "root-fixture",
      supportsAllDrives: true,
    });

    expect(result).toMatchObject({
      error: { code: "PROVIDER_FAILURE", retryable: false },
      ok: false,
    });
  });

  test("retries only safe reads and maps exhausted quota and permission failures without leaking provider text", async () => {
    let listAttempt = 0;
    const delays: number[] = [];
    const list = vi.fn<GoogleDriveApi["files"]["list"]>(() => {
      listAttempt += 1;
      if (listAttempt < 3) {
        return Promise.reject(googleError(429, "rateLimitExceeded"));
      }
      return Promise.resolve({
        data: { files: [], incompleteSearch: false, nextPageToken: null },
      });
    });
    const provider = createGoogleDriveProviders({
      api: googleApi({ list }),
      authorizationMode: "content",
      retry: {
        baseDelayMs: 10,
        maxDelayMs: 100,
        maxReadRetries: 2,
        random: () => 0,
        sleep: (delayMs) => {
          delays.push(delayMs);
          return Promise.resolve();
        },
      },
    });
    const recovered = await provider.read.listItems({
      pageSize: 10,
      pageToken: null,
      rootId: "root-fixture",
      supportsAllDrives: true,
    });
    expect(recovered).toEqual({
      ok: true,
      value: { items: [], nextPageToken: null },
    });
    expect(list).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([10, 20]);

    const exhaustedList = vi.fn<GoogleDriveApi["files"]["list"]>(() =>
      Promise.reject(googleError(403, "userRateLimitExceeded")),
    );
    const exhaustedProvider = createGoogleDriveProviders({
      api: googleApi({ list: exhaustedList }),
      authorizationMode: "content",
      retry: {
        baseDelayMs: 1,
        maxDelayMs: 1,
        maxReadRetries: 1,
        random: () => 0,
        sleep: () => Promise.resolve(),
      },
    });
    const exhausted = await exhaustedProvider.read.listItems({
      pageSize: 10,
      pageToken: null,
      rootId: "root-fixture",
      supportsAllDrives: true,
    });
    expect(exhausted).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        itemId: "root-fixture",
        retryable: true,
      },
      ok: false,
    });
    expect(exhaustedList).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(exhausted)).not.toContain("fixture-secret");

    const deniedGet = vi.fn<GoogleDriveApi["files"]["get"]>(() =>
      Promise.reject(googleError(403, "insufficientFilePermissions")),
    );
    const deniedProvider = createGoogleDriveProviders({
      api: googleApi({ get: deniedGet }),
      authorizationMode: "content",
    });
    const denied = await deniedProvider.read.getItem("denied-fixture");
    expect(denied).toMatchObject({
      error: { code: "DENIED", retryable: false },
      ok: false,
    });
    expect(deniedGet).toHaveBeenCalledTimes(1);
  });

  test("fresh-checks rename, creates only shortcuts, and never retries an ambiguous mutation", async () => {
    const get = vi.fn<GoogleDriveApi["files"]["get"]>(() =>
      Promise.resolve({ data: googleFile() }),
    );
    const update = vi.fn<GoogleDriveApi["files"]["update"]>(() =>
      Promise.resolve({
        data: googleFile({
          modifiedTime: "2026-08-08T12:31:00.000Z",
          name: "Approved invoice.pdf",
        }),
      }),
    );
    const create = vi.fn<GoogleDriveApi["files"]["create"]>(() =>
      Promise.resolve({
        data: googleFile({
          id: "shortcut-created",
          mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
          modifiedTime: "2026-08-08T12:32:00.000Z",
          name: "Approved shortcut",
          parents: ["destination-fixture"],
          sha256Checksum: null,
          shortcutDetails: { targetId: "item-fixture" },
        }),
      }),
    );
    const provider = createGoogleDriveProviders({
      api: googleApi({ create, get, update }),
      authorizationMode: "apply",
    });
    if (!("mutation" in provider)) {
      throw new Error("Apply mode did not expose its mutation provider.");
    }

    const rename = await provider.mutation.rename({
      expectedModifiedTime: "2026-08-08T12:30:00.000Z",
      name: "Approved invoice.pdf",
      targetId: "item-fixture",
    });
    expect(rename).toMatchObject({
      ok: true,
      value: {
        id: "item-fixture",
        name: "Approved invoice.pdf",
        shortcutTargetId: null,
      },
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      fields: GOOGLE_FILE_FIELDS,
      fileId: "item-fixture",
      requestBody: { name: "Approved invoice.pdf" },
      supportsAllDrives: true,
    });

    const shortcut = await provider.mutation.createShortcut({
      name: "Approved shortcut",
      parentId: "destination-fixture",
      targetId: "item-fixture",
    });
    expect(shortcut).toMatchObject({
      ok: true,
      value: {
        id: "shortcut-created",
        shortcutTargetId: "item-fixture",
      },
    });
    expect(create).toHaveBeenCalledWith({
      fields: GOOGLE_FILE_FIELDS,
      requestBody: {
        mimeType: GOOGLE_SHORTCUT_MIME_TYPE,
        name: "Approved shortcut",
        parents: ["destination-fixture"],
        shortcutDetails: { targetId: "item-fixture" },
      },
      supportsAllDrives: true,
    });

    const staleGet = vi.fn<GoogleDriveApi["files"]["get"]>(() =>
      Promise.resolve({
        data: googleFile({ modifiedTime: "2026-08-08T12:35:00.000Z" }),
      }),
    );
    const staleUpdate = vi.fn<GoogleDriveApi["files"]["update"]>(() =>
      Promise.resolve({ data: googleFile() }),
    );
    const staleProvider = createGoogleDriveProviders({
      api: googleApi({ get: staleGet, update: staleUpdate }),
      authorizationMode: "apply",
    });
    if (!("mutation" in staleProvider)) {
      throw new Error("Apply mode did not expose its mutation provider.");
    }
    const stale = await staleProvider.mutation.rename({
      expectedModifiedTime: "2026-08-08T12:30:00.000Z",
      name: "Approved invoice.pdf",
      targetId: "item-fixture",
    });
    expect(stale).toMatchObject({
      error: { code: "STALE_STATE", retryable: false },
      ok: false,
    });
    expect(staleUpdate).not.toHaveBeenCalled();

    const limitedCreate = vi.fn<GoogleDriveApi["files"]["create"]>(() =>
      Promise.reject(googleError(429, "rateLimitExceeded")),
    );
    const limitedProvider = createGoogleDriveProviders({
      api: googleApi({ create: limitedCreate }),
      authorizationMode: "apply",
      retry: {
        baseDelayMs: 1,
        maxDelayMs: 1,
        maxReadRetries: 3,
        random: () => 0,
        sleep: () => Promise.resolve(),
      },
    });
    if (!("mutation" in limitedProvider)) {
      throw new Error("Apply mode did not expose its mutation provider.");
    }
    const limited = await limitedProvider.mutation.createShortcut({
      name: "Approved shortcut",
      parentId: "destination-fixture",
      targetId: "item-fixture",
    });
    expect(limited).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
      ok: false,
    });
    expect(limitedCreate).toHaveBeenCalledTimes(1);
  });

  test("exports bytes only with a content-capable profile and maps unsupported exports", async () => {
    const exportFile = vi.fn<GoogleDriveApi["files"]["export"]>(() =>
      Promise.resolve({
        data: new TextEncoder().encode("synthetic export"),
      }),
    );
    const provider = createGoogleDriveProviders({
      api: googleApi({ export: exportFile }),
      authorizationMode: "content",
    });
    const exported = await provider.read.exportItem({
      exportMimeType: "text/plain",
      itemId: "item-fixture",
    });
    expect(exported).toEqual({
      ok: true,
      value: {
        bytes: new TextEncoder().encode("synthetic export"),
        mimeType: "text/plain",
      },
    });

    const unsupportedExport = vi.fn<GoogleDriveApi["files"]["export"]>(() =>
      Promise.reject(googleError(403, "fileNotExportable")),
    );
    const unsupportedProvider = createGoogleDriveProviders({
      api: googleApi({ export: unsupportedExport }),
      authorizationMode: "content",
    });
    const unsupported = await unsupportedProvider.read.exportItem({
      exportMimeType: "text/plain",
      itemId: "item-fixture",
    });
    expect(unsupported).toMatchObject({
      error: { code: "UNSUPPORTED_EXPORT", retryable: false },
      ok: false,
    });
  });

  test("stores separate authorized-user tokens outside the workspace with restrictive permissions", async () => {
    const base = temporaryDirectory("dvw-google-token-contract-");
    const workspaceRoot = join(base, "workspace");
    const configDirectory = join(base, "config", "drive-vetting-workbench");
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const store = new GoogleTokenStore({ configDirectory, workspaceRoot });

    await store.save({
      authorizedUser: {
        client_id: "fixture-client-id",
        client_secret: "fixture-client-secret",
        refresh_token: "fixture-refresh-token",
        type: "authorized_user",
      },
      mode: "metadata",
    });
    const tokenPath = store.pathFor("metadata");
    expect(tokenPath.startsWith(workspaceRoot)).toBe(false);
    expect(statSync(dirname(tokenPath)).mode & 0o777).toBe(0o700);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(await store.load("metadata")).toMatchObject({
      mode: "metadata",
      scopes: GOOGLE_AUTHORIZATION_SCOPES.metadata,
    });
    expect(store.pathFor("apply")).not.toBe(tokenPath);
    expect(() => store.pathFor("../escape" as never)).toThrow(
      /authorization mode/u,
    );

    chmodSync(tokenPath, 0o644);
    await expect(store.load("metadata")).rejects.toMatchObject({
      code: "INSECURE_TOKEN_PERMISSIONS",
    });

    expect(
      () =>
        new GoogleTokenStore({
          configDirectory: join(workspaceRoot, ".tokens"),
          workspaceRoot,
        }),
    ).toThrow(/outside the workspace/u);
  });

  test("rejects token storage redirected into the workspace through a symlink", async () => {
    const base = temporaryDirectory("dvw-google-token-symlink-contract-");
    const workspaceRoot = join(base, "workspace");
    const workspaceTarget = join(workspaceRoot, "redirected-config");
    const configDirectory = join(base, "config", "drive-vetting-workbench");
    mkdirSync(workspaceTarget, { mode: 0o700, recursive: true });
    mkdirSync(dirname(configDirectory), { mode: 0o700, recursive: true });
    symlinkSync(workspaceTarget, configDirectory, "dir");
    const store = new GoogleTokenStore({ configDirectory, workspaceRoot });

    await expect(
      store.save({
        authorizedUser: {
          client_id: "fixture-client-id",
          client_secret: "fixture-client-secret",
          refresh_token: "fixture-refresh-token",
          type: "authorized_user",
        },
        mode: "metadata",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CREDENTIAL_PATH" });
    expect(existsSync(join(workspaceTarget, "tokens"))).toBe(false);
  });

  test("uses the installed-app authenticator only when its mode-specific token is absent", async () => {
    const base = temporaryDirectory("dvw-google-auth-contract-");
    const workspaceRoot = join(base, "workspace");
    const configDirectory = join(base, "config", "drive-vetting-workbench");
    const clientCredentialsPath = join(base, "oauth", "client_secret.json");
    mkdirSync(workspaceRoot, { mode: 0o700 });
    mkdirSync(dirname(clientCredentialsPath), { mode: 0o700 });
    writeFileSync(
      clientCredentialsPath,
      `${JSON.stringify({
        installed: {
          client_id: "fixture-client-id",
          client_secret: "fixture-client-secret",
          redirect_uris: ["http://localhost"],
        },
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const store = new GoogleTokenStore({ configDirectory, workspaceRoot });
    const localAuthenticate = vi.fn(() =>
      Promise.resolve({
        credentials: { refresh_token: "fixture-refresh-token" },
      }),
    );
    const restoredClient = {
      credentials: { refresh_token: "fixture-refresh-token" },
    } as unknown as GoogleAuthClient;
    const fromJSON = vi.fn(() => restoredClient);

    const first = await authorizeGoogleDrive({
      clientCredentialsPath,
      fromJSON,
      localAuthenticate,
      mode: "content",
      tokenStore: store,
      workspaceRoot,
    });
    expect(first).toBe(restoredClient);
    expect(localAuthenticate).toHaveBeenCalledWith({
      keyfilePath: clientCredentialsPath,
      scopes: GOOGLE_AUTHORIZATION_SCOPES.content,
    });
    expect(fromJSON).toHaveBeenCalledWith({
      client_id: "fixture-client-id",
      client_secret: "fixture-client-secret",
      refresh_token: "fixture-refresh-token",
      type: "authorized_user",
    });
    expect(readFileSync(store.pathFor("content"), "utf8")).not.toContain(
      "access_token",
    );

    localAuthenticate.mockRejectedValueOnce(
      new Error("The browser authenticator must not run twice."),
    );
    const second = await authorizeGoogleDrive({
      clientCredentialsPath,
      fromJSON,
      localAuthenticate,
      mode: "content",
      tokenStore: store,
      workspaceRoot,
    });
    expect(second).toBe(restoredClient);
    expect(localAuthenticate).toHaveBeenCalledTimes(1);
  });
});
