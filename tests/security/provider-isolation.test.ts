import { readFileSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  READ_ONLY_TOOL_NAMES,
  createDriveVettingMcpServer,
} from "@dvw/mcp-server";
import type { QueryService } from "@dvw/query-service";
import { resolveSandboxPath } from "@dvw/drive-simulator";
import {
  GOOGLE_AUTHORIZATION_SCOPES,
  GoogleTokenStore,
  createGoogleDriveProviders,
  type GoogleDriveApi,
} from "../../packages/drive-google/src/index.js";
import { describe, expect, test } from "vitest";

function packageManifest(path: string): {
  readonly dependencies?: Readonly<Record<string, string>>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
}

function unavailableGoogleApi(): GoogleDriveApi {
  const unavailable = () =>
    Promise.reject(new Error("No Google request is allowed in this test."));
  return {
    files: {
      create: unavailable,
      export: unavailable,
      get: unavailable,
      list: unavailable,
      update: unavailable,
    },
  };
}

describe("provider, OAuth, Drive Lab, and MCP isolation", () => {
  test("rejects traversal and symlink escape without exposing a real provider", () => {
    const base = mkdtempSync(join(tmpdir(), "dvw-security-lab-path-"));
    const root = join(base, "lab");
    const outside = join(base, "outside");
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(root, "redirect"), "dir");

    expect(() => resolveSandboxPath(root, "../outside/item.json")).toThrow(
      /inside the sandbox/u,
    );
    expect(() => resolveSandboxPath(root, join(outside, "item.json"))).toThrow(
      /inside the sandbox/u,
    );
    expect(() => resolveSandboxPath(root, "redirect/item.json")).toThrow(
      /symlink/u,
    );

    const simulatorPackage = packageManifest(
      join(process.cwd(), "packages/drive-simulator/package.json"),
    );
    expect(Object.keys(simulatorPackage.dependencies ?? {})).not.toContain(
      "@dvw/drive-google",
    );
  });

  test("keeps read profiles separate from the only mutation-capable scope", () => {
    const api = unavailableGoogleApi();
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

    expect(GOOGLE_AUTHORIZATION_SCOPES).toEqual({
      apply: ["https://www.googleapis.com/auth/drive"],
      content: ["https://www.googleapis.com/auth/drive.readonly"],
      metadata: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
    });
    expect("mutation" in metadata).toBe(false);
    expect("mutation" in content).toBe(false);
    expect("mutation" in apply).toBe(true);
    expect(() =>
      createGoogleDriveProviders({
        api,
        authorizationMode: "invalid" as never,
      }),
    ).toThrow(/authorization mode/u);

    const workspace = join(process.cwd(), "synthetic-workspace");
    expect(
      () =>
        new GoogleTokenStore({
          configDirectory: join(workspace, ".tokens"),
          workspaceRoot: workspace,
        }),
    ).toThrow(/outside the workspace/u);
  });

  test("registers only bounded read tools and cannot resolve an apply call", async () => {
    const query = {} as unknown as QueryService;
    const server = createDriveVettingMcpServer(query);
    const client = new Client({ name: "dvw-security-host", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        READ_ONLY_TOOL_NAMES,
      );
      expect(
        listed.tools.every(
          (tool) =>
            tool.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint === false,
        ),
      ).toBe(true);
      expect(listed.tools.map((tool) => tool.name).join(" ")).not.toMatch(
        /apply|approve|credential|delete|execute|move|rename|shell|write/iu,
      );
      await expect(
        client.callTool({ arguments: {}, name: "apply" }),
      ).rejects.toThrow();

      const mcpPackage = packageManifest(
        join(process.cwd(), "apps/mcp-server/package.json"),
      );
      const dependencies = Object.keys(mcpPackage.dependencies ?? {});
      expect(dependencies).not.toContain("@dvw/drive-google");
      expect(dependencies).not.toContain("@dvw/execution");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
