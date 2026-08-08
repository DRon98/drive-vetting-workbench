import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import open from "open";

export type GoogleAuthClient = OAuth2Client;

export interface GoogleAuthorizationExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export type GoogleAuthorizationCodeExchange = (
  client: GoogleAuthClient,
  input: GoogleAuthorizationExchangeInput,
) => Promise<{ readonly refreshToken: string | null }>;

export type GoogleBrowserOpener = (authorizationUrl: string) => Promise<void>;

export class GoogleInstalledAuthError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GoogleInstalledAuthError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

async function loadInstalledClient(path: string): Promise<{
  readonly clientId: string;
  readonly clientSecret: string;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new GoogleInstalledAuthError(
      "CLIENT_CREDENTIALS_READ_FAILED",
      "The Google OAuth client credentials could not be read.",
      { cause: error },
    );
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.installed) ||
    !isNonEmptyString(parsed.installed.client_id) ||
    !isNonEmptyString(parsed.installed.client_secret)
  ) {
    throw new GoogleInstalledAuthError(
      "INVALID_CLIENT_CREDENTIALS",
      "The Google OAuth client file must contain Desktop app credentials.",
    );
  }
  return {
    clientId: parsed.installed.client_id,
    clientSecret: parsed.installed.client_secret,
  };
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => {
      rejectPromise(
        new GoogleInstalledAuthError(
          "LOOPBACK_LISTEN_FAILED",
          "The local OAuth callback could not start.",
          { cause: error },
        ),
      );
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPromise(
          new GoogleInstalledAuthError(
            "LOOPBACK_LISTEN_FAILED",
            "The local OAuth callback did not receive a TCP port.",
          ),
        );
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}

const defaultOpenBrowser: GoogleBrowserOpener = async (authorizationUrl) => {
  await open(authorizationUrl, { wait: false });
};

const defaultExchangeCode: GoogleAuthorizationCodeExchange = async (
  client,
  input,
) => {
  const response = await client.getToken({
    code: input.code,
    codeVerifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  });
  return { refreshToken: response.tokens.refresh_token ?? null };
};

export async function authenticateGoogleInstalledApp(input: {
  readonly clientCredentialsPath: string;
  readonly exchangeCode?: GoogleAuthorizationCodeExchange;
  readonly openBrowser?: GoogleBrowserOpener;
  readonly scopes: readonly string[];
  readonly stateFactory?: () => string;
  readonly timeoutMs?: number;
}): Promise<GoogleAuthClient> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new GoogleInstalledAuthError(
      "INVALID_TIMEOUT",
      "The local OAuth callback timeout must be a positive integer.",
    );
  }
  if (
    input.scopes.length === 0 ||
    input.scopes.some((scope) => !isNonEmptyString(scope))
  ) {
    throw new GoogleInstalledAuthError(
      "INVALID_SCOPES",
      "At least one Google OAuth scope is required.",
    );
  }
  const installed = await loadInstalledClient(input.clientCredentialsPath);
  const state = input.stateFactory?.() ?? randomBytes(32).toString("base64url");
  if (!isNonEmptyString(state)) {
    throw new GoogleInstalledAuthError(
      "INVALID_STATE",
      "The local OAuth state value is invalid.",
    );
  }

  let resolveAuthorizationCode!: (code: string) => void;
  let rejectAuthorizationCode!: (error: Error) => void;
  let callbackSettled = false;
  const authorizationCode = new Promise<string>(
    (resolvePromise, rejectPromise) => {
      resolveAuthorizationCode = resolvePromise;
      rejectAuthorizationCode = rejectPromise;
    },
  );
  const server = createServer((request, response) => {
    const rejectCallback = (code: string, message: string) => {
      response.statusCode = 400;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(
        "Authorization was not accepted. Return to the application.",
      );
      if (!callbackSettled) {
        callbackSettled = true;
        rejectAuthorizationCode(new GoogleInstalledAuthError(code, message));
      }
    };
    if (request.method !== "GET" || request.url === undefined) {
      rejectCallback(
        "INVALID_CALLBACK",
        "The local OAuth callback request was invalid.",
      );
      return;
    }
    const callback = new URL(request.url, "http://127.0.0.1");
    if (callback.pathname !== "/oauth2callback") {
      rejectCallback(
        "INVALID_CALLBACK",
        "The local OAuth callback path was invalid.",
      );
      return;
    }
    if (callback.searchParams.get("state") !== state) {
      rejectCallback(
        "STATE_MISMATCH",
        "The local OAuth callback state did not match.",
      );
      return;
    }
    const code = callback.searchParams.get("code");
    if (!isNonEmptyString(code)) {
      rejectCallback(
        "AUTHORIZATION_DENIED",
        "Google did not return an authorization code.",
      );
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Authorization received. Return to Drive Vetting Workbench.");
    if (!callbackSettled) {
      callbackSettled = true;
      resolveAuthorizationCode(code);
    }
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await listenOnLoopback(server);
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const client = new OAuth2Client(
      installed.clientId,
      installed.clientSecret,
      redirectUri,
    );
    const verifier = await client.generateCodeVerifierAsync();
    if (
      !isNonEmptyString(verifier.codeChallenge) ||
      !isNonEmptyString(verifier.codeVerifier)
    ) {
      throw new GoogleInstalledAuthError(
        "PKCE_GENERATION_FAILED",
        "The OAuth client could not generate a PKCE challenge.",
      );
    }
    const authorizationUrl = client.generateAuthUrl({
      access_type: "offline",
      code_challenge: verifier.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      include_granted_scopes: false,
      prompt: "consent",
      scope: [...input.scopes],
      state,
    });
    const timedCode = new Promise<string>((_resolvePromise, rejectPromise) => {
      timeout = setTimeout(() => {
        rejectPromise(
          new GoogleInstalledAuthError(
            "CALLBACK_TIMEOUT",
            "The local OAuth callback timed out.",
          ),
        );
      }, timeoutMs);
    });
    const pendingCode = Promise.race([authorizationCode, timedCode]);
    const browserOpen = (input.openBrowser ?? defaultOpenBrowser)(
      authorizationUrl,
    );
    const [code] = await Promise.all([pendingCode, browserOpen]);
    const exchanged = await (input.exchangeCode ?? defaultExchangeCode)(
      client,
      {
        code,
        codeVerifier: verifier.codeVerifier,
        redirectUri,
      },
    );
    if (!isNonEmptyString(exchanged.refreshToken)) {
      throw new GoogleInstalledAuthError(
        "REFRESH_TOKEN_MISSING",
        "Google did not return a refresh token for the installed application.",
      );
    }
    client.setCredentials({ refresh_token: exchanged.refreshToken });
    return client;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await closeServer(server);
  }
}
