import { describe, expect, test } from "vitest";
import { createAuthorizedGoogleDriveProviders } from "../../../packages/drive-google/src/index.js";

const sandboxEnabled = process.env.DVW_GOOGLE_SANDBOX === "1";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`The ${name} sandbox setting is required.`);
  }
  return value;
}

describe.skipIf(!sandboxEnabled)("opt-in Google Drive sandbox", () => {
  test("reads only an explicitly named disposable synthetic folder", async () => {
    const rootId = requiredEnvironment("DVW_GOOGLE_SANDBOX_ROOT_ID");
    const providers = await createAuthorizedGoogleDriveProviders({
      authorizationMode: "content",
      clientCredentialsPath: requiredEnvironment(
        "DVW_GOOGLE_CLIENT_CREDENTIALS",
      ),
      provider: {
        sharedDriveId: process.env.DVW_GOOGLE_SANDBOX_SHARED_DRIVE_ID ?? null,
      },
      workspaceRoot: process.cwd(),
    });
    const root = await providers.read.getItem(rootId);
    if (!root.ok || root.value === null) {
      throw new Error("The configured Google sandbox root is not readable.");
    }
    expect(root.value.name.startsWith("DVW Sandbox")).toBe(true);

    const page = await providers.read.listItems({
      pageSize: 10,
      pageToken: null,
      rootId,
      supportsAllDrives: true,
    });
    expect(page.ok).toBe(true);
    expect("mutation" in providers).toBe(false);
  });
});
