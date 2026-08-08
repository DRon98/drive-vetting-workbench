import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { OAuth2Client } from "google-auth-library";
import {
  authenticateGoogleInstalledApp,
  type GoogleAuthClient,
} from "./installed-auth.js";

export type GoogleAuthorizationMode = "apply" | "content" | "metadata";

export const GOOGLE_AUTHORIZATION_SCOPES = {
  apply: ["https://www.googleapis.com/auth/drive"],
  content: ["https://www.googleapis.com/auth/drive.readonly"],
  metadata: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
} as const satisfies Record<GoogleAuthorizationMode, readonly string[]>;

export interface GoogleAuthorizedUserCredentials {
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
  readonly type: "authorized_user";
}

export interface StoredGoogleToken {
  readonly authorizedUser: GoogleAuthorizedUserCredentials;
  readonly mode: GoogleAuthorizationMode;
  readonly scopes: readonly string[];
  readonly version: 1;
}

export type { GoogleAuthClient } from "./installed-auth.js";

export interface LocalAuthenticatedClient {
  readonly credentials: {
    readonly refresh_token?: string | null;
  };
}

export type GoogleLocalAuthenticate = (input: {
  readonly keyfilePath: string;
  readonly scopes: readonly string[];
}) => Promise<LocalAuthenticatedClient>;

export type GoogleAuthFromJSON = (
  credentials: GoogleAuthorizedUserCredentials,
) => GoogleAuthClient;

export class GoogleAuthError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GoogleAuthError";
  }
}

export function assertGoogleAuthorizationMode(
  value: unknown,
): asserts value is GoogleAuthorizationMode {
  if (value !== "metadata" && value !== "content" && value !== "apply") {
    throw new GoogleAuthError(
      "INVALID_AUTHORIZATION_MODE",
      "The Google authorization mode is invalid.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function assertOutsideWorkspace(
  candidatePath: string,
  workspaceRoot: string,
  label: string,
): void {
  const absoluteCandidate = resolve(candidatePath);
  const absoluteWorkspace = resolve(workspaceRoot);
  assertResolvedOutsideWorkspace(absoluteCandidate, absoluteWorkspace, label);
}

function assertResolvedOutsideWorkspace(
  absoluteCandidate: string,
  absoluteWorkspace: string,
  label: string,
): void {
  const displacement = relative(absoluteWorkspace, absoluteCandidate);
  const isInside =
    displacement === "" ||
    (displacement !== ".." &&
      !displacement.startsWith(`..${sep}`) &&
      !isAbsolute(displacement));
  if (isInside) {
    throw new GoogleAuthError(
      "WORKSPACE_CREDENTIAL_PATH",
      `${label} must be outside the workspace.`,
    );
  }
}

async function canonicalizePotentialPath(
  candidatePath: string,
): Promise<string> {
  let existingAncestor = resolve(candidatePath);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      return resolve(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new GoogleAuthError(
          "CREDENTIAL_PATH_CHECK_FAILED",
          "The Google credential path could not be validated.",
          { cause: error },
        );
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new GoogleAuthError(
          "CREDENTIAL_PATH_CHECK_FAILED",
          "The Google credential path could not be validated.",
          { cause: error },
        );
      }
      missingSegments.push(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function assertCanonicalOutsideWorkspace(
  candidatePath: string,
  workspaceRoot: string,
  label: string,
): Promise<void> {
  assertOutsideWorkspace(candidatePath, workspaceRoot, label);
  const [canonicalCandidate, canonicalWorkspace] = await Promise.all([
    canonicalizePotentialPath(candidatePath),
    canonicalizePotentialPath(workspaceRoot),
  ]);
  assertResolvedOutsideWorkspace(canonicalCandidate, canonicalWorkspace, label);
}

function parseAuthorizedUser(value: unknown): GoogleAuthorizedUserCredentials {
  if (
    !isRecord(value) ||
    value.type !== "authorized_user" ||
    !isNonEmptyString(value.client_id) ||
    !isNonEmptyString(value.client_secret) ||
    !isNonEmptyString(value.refresh_token)
  ) {
    throw new GoogleAuthError(
      "INVALID_TOKEN_FILE",
      "The Google token file is invalid.",
    );
  }
  return {
    client_id: value.client_id,
    client_secret: value.client_secret,
    refresh_token: value.refresh_token,
    type: "authorized_user",
  };
}

function parseToken(
  value: unknown,
  expectedMode: GoogleAuthorizationMode,
): StoredGoogleToken {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.mode !== expectedMode ||
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => !isNonEmptyString(scope))
  ) {
    throw new GoogleAuthError(
      "INVALID_TOKEN_FILE",
      "The Google token file is invalid.",
    );
  }
  const expectedScopes = GOOGLE_AUTHORIZATION_SCOPES[expectedMode];
  if (
    value.scopes.length !== expectedScopes.length ||
    value.scopes.some((scope, index) => scope !== expectedScopes[index])
  ) {
    throw new GoogleAuthError(
      "TOKEN_SCOPE_MISMATCH",
      "The Google token does not match the requested authorization mode.",
    );
  }
  return {
    authorizedUser: parseAuthorizedUser(value.authorizedUser),
    mode: expectedMode,
    scopes: [...expectedScopes],
    version: 1,
  };
}

function parseInstalledCredentials(value: unknown): {
  clientId: string;
  clientSecret: string;
} {
  if (
    !isRecord(value) ||
    !isRecord(value.installed) ||
    !isNonEmptyString(value.installed.client_id) ||
    !isNonEmptyString(value.installed.client_secret)
  ) {
    throw new GoogleAuthError(
      "INVALID_CLIENT_CREDENTIALS",
      "The Google OAuth client file must contain Desktop app credentials.",
    );
  }
  return {
    clientId: value.installed.client_id,
    clientSecret: value.installed.client_secret,
  };
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function fileMode(statMode: number): number {
  return statMode & 0o777;
}

export function resolveGoogleConfigDirectory(
  input: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly homeDirectory?: string;
  } = {},
): string {
  const environment = input.environment ?? process.env;
  const configured = environment.DVW_CONFIG_DIR;
  if (isNonEmptyString(configured)) {
    return resolve(configured);
  }
  const xdgConfig = environment.XDG_CONFIG_HOME;
  const root = isNonEmptyString(xdgConfig)
    ? resolve(xdgConfig)
    : join(input.homeDirectory ?? homedir(), ".config");
  return join(root, "drive-vetting-workbench");
}

export class GoogleTokenStore {
  readonly #configDirectory: string;
  readonly #workspaceRoot: string;

  public constructor(input: {
    readonly configDirectory: string;
    readonly workspaceRoot: string;
  }) {
    assertOutsideWorkspace(
      input.configDirectory,
      input.workspaceRoot,
      "Google token storage",
    );
    this.#configDirectory = resolve(input.configDirectory);
    this.#workspaceRoot = resolve(input.workspaceRoot);
  }

  public pathFor(mode: GoogleAuthorizationMode): string {
    assertGoogleAuthorizationMode(mode);
    return join(this.#configDirectory, "tokens", `${mode}.json`);
  }

  async #ensureTokenDirectory(): Promise<void> {
    const directory = join(this.#configDirectory, "tokens");
    await assertCanonicalOutsideWorkspace(
      directory,
      this.#workspaceRoot,
      "Google token storage",
    );
    await mkdir(directory, { mode: 0o700, recursive: true });
    await assertCanonicalOutsideWorkspace(
      directory,
      this.#workspaceRoot,
      "Google token storage",
    );
    const directoryStat = await stat(directory);
    if (fileMode(directoryStat.mode) & 0o077) {
      throw new GoogleAuthError(
        "INSECURE_TOKEN_DIRECTORY",
        "The Google token directory permissions are too broad.",
      );
    }
  }

  public async load(
    mode: GoogleAuthorizationMode,
  ): Promise<StoredGoogleToken | null> {
    const path = this.pathFor(mode);
    await assertCanonicalOutsideWorkspace(
      path,
      this.#workspaceRoot,
      "Google token storage",
    );
    let tokenStat;
    try {
      tokenStat = await stat(path);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new GoogleAuthError(
        "TOKEN_READ_FAILED",
        "The Google token metadata could not be read.",
        { cause: error },
      );
    }
    if (!tokenStat.isFile() || fileMode(tokenStat.mode) & 0o077) {
      throw new GoogleAuthError(
        "INSECURE_TOKEN_PERMISSIONS",
        "The Google token file must use mode 0600.",
      );
    }
    try {
      return parseToken(JSON.parse(await readFile(path, "utf8")), mode);
    } catch (error) {
      if (error instanceof GoogleAuthError) throw error;
      throw new GoogleAuthError(
        "INVALID_TOKEN_FILE",
        "The Google token file is invalid.",
        { cause: error },
      );
    }
  }

  public async save(input: {
    readonly authorizedUser: GoogleAuthorizedUserCredentials;
    readonly mode: GoogleAuthorizationMode;
  }): Promise<StoredGoogleToken> {
    assertGoogleAuthorizationMode(input.mode);
    const authorizedUser = parseAuthorizedUser(input.authorizedUser);
    await this.#ensureTokenDirectory();
    const token: StoredGoogleToken = {
      authorizedUser,
      mode: input.mode,
      scopes: [...GOOGLE_AUTHORIZATION_SCOPES[input.mode]],
      version: 1,
    };
    try {
      await writeFile(this.pathFor(input.mode), `${JSON.stringify(token)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      throw new GoogleAuthError(
        isRecord(error) && error.code === "EEXIST"
          ? "TOKEN_ALREADY_EXISTS"
          : "TOKEN_WRITE_FAILED",
        "The Google token could not be stored without overwriting existing data.",
        { cause: error },
      );
    }
    const written = await stat(this.pathFor(input.mode));
    if (fileMode(written.mode) !== 0o600) {
      throw new GoogleAuthError(
        "INSECURE_TOKEN_PERMISSIONS",
        "The Google token file must use mode 0600.",
      );
    }
    return token;
  }
}

const defaultLocalAuthenticate: GoogleLocalAuthenticate = async (input) =>
  authenticateGoogleInstalledApp({
    clientCredentialsPath: input.keyfilePath,
    scopes: [...input.scopes],
  });

const defaultFromJSON: GoogleAuthFromJSON = (credentials) => {
  const client = new OAuth2Client(
    credentials.client_id,
    credentials.client_secret,
  );
  client.setCredentials({ refresh_token: credentials.refresh_token });
  return client;
};

export async function authorizeGoogleDrive(input: {
  readonly clientCredentialsPath: string;
  readonly fromJSON?: GoogleAuthFromJSON;
  readonly localAuthenticate?: GoogleLocalAuthenticate;
  readonly mode: GoogleAuthorizationMode;
  readonly tokenStore: GoogleTokenStore;
  readonly workspaceRoot: string;
}): Promise<GoogleAuthClient> {
  assertGoogleAuthorizationMode(input.mode);
  await assertCanonicalOutsideWorkspace(
    input.clientCredentialsPath,
    input.workspaceRoot,
    "Google OAuth client credentials",
  );
  const fromJSON = input.fromJSON ?? defaultFromJSON;
  const stored = await input.tokenStore.load(input.mode);
  if (stored !== null) {
    return fromJSON(stored.authorizedUser);
  }

  let clientFile: unknown;
  try {
    clientFile = JSON.parse(
      await readFile(input.clientCredentialsPath, "utf8"),
    );
  } catch (error) {
    throw new GoogleAuthError(
      "CLIENT_CREDENTIALS_READ_FAILED",
      "The Google OAuth client credentials could not be read.",
      { cause: error },
    );
  }
  const installed = parseInstalledCredentials(clientFile);
  const localClient = await (
    input.localAuthenticate ?? defaultLocalAuthenticate
  )({
    keyfilePath: input.clientCredentialsPath,
    scopes: GOOGLE_AUTHORIZATION_SCOPES[input.mode],
  });
  const refreshToken = localClient.credentials.refresh_token;
  if (!isNonEmptyString(refreshToken)) {
    throw new GoogleAuthError(
      "REFRESH_TOKEN_MISSING",
      "Google did not return a refresh token for the installed application.",
    );
  }
  const authorizedUser: GoogleAuthorizedUserCredentials = {
    client_id: installed.clientId,
    client_secret: installed.clientSecret,
    refresh_token: refreshToken,
    type: "authorized_user",
  };
  await input.tokenStore.save({ authorizedUser, mode: input.mode });
  return fromJSON(authorizedUser);
}
