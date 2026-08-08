import { drive as createDriveClient } from "@googleapis/drive";
import type {
  GoogleAuthClient,
  GoogleAuthorizationMode,
  GoogleAuthFromJSON,
  GoogleLocalAuthenticate,
  GoogleTokenStore,
} from "./oauth.js";
import {
  authorizeGoogleDrive,
  GoogleTokenStore as DefaultGoogleTokenStore,
  resolveGoogleConfigDirectory,
} from "./oauth.js";
import {
  createGoogleDriveProviders,
  type GoogleDriveProviderBundle,
  type GoogleDriveProviderOptions,
} from "./provider.js";
import type { GoogleDriveApi, GoogleExportData } from "./types.js";

export function createGoogleApisDriveApi(
  auth: GoogleAuthClient,
): GoogleDriveApi {
  const drive = createDriveClient({ auth, version: "v3" });
  return {
    files: {
      async create(request) {
        const response = await drive.files.create(request);
        return { data: response.data };
      },
      async export(request) {
        const response = await drive.files.export(request, {
          responseType: "arraybuffer",
        });
        return { data: response.data as GoogleExportData };
      },
      async get(request) {
        const response = await drive.files.get(request);
        return { data: response.data };
      },
      async list(request) {
        const response = await drive.files.list(request);
        return { data: response.data };
      },
      async update(request) {
        const response = await drive.files.update(request);
        return { data: response.data };
      },
    },
  };
}

export async function createAuthorizedGoogleDriveProviders(input: {
  readonly authorizationMode: GoogleAuthorizationMode;
  readonly clientCredentialsPath: string;
  readonly configDirectory?: string;
  readonly fromJSON?: GoogleAuthFromJSON;
  readonly localAuthenticate?: GoogleLocalAuthenticate;
  readonly provider?: Omit<
    GoogleDriveProviderOptions,
    "api" | "authorizationMode"
  >;
  readonly tokenStore?: GoogleTokenStore;
  readonly workspaceRoot?: string;
}): Promise<GoogleDriveProviderBundle> {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const tokenStore =
    input.tokenStore ??
    new DefaultGoogleTokenStore({
      configDirectory: input.configDirectory ?? resolveGoogleConfigDirectory(),
      workspaceRoot,
    });
  const auth = await authorizeGoogleDrive({
    clientCredentialsPath: input.clientCredentialsPath,
    ...(input.fromJSON === undefined ? {} : { fromJSON: input.fromJSON }),
    ...(input.localAuthenticate === undefined
      ? {}
      : { localAuthenticate: input.localAuthenticate }),
    mode: input.authorizationMode,
    tokenStore,
    workspaceRoot,
  });
  return createGoogleDriveProviders({
    ...input.provider,
    api: createGoogleApisDriveApi(auth),
    authorizationMode: input.authorizationMode,
  });
}
