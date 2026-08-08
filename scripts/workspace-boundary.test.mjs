import { describe, expect, it } from "vitest";

describe("workspace boundary scanner", () => {
  it("finds external repository references across product files", async () => {
    const boundary = await import("./check-workspace-boundary.mjs");

    expect(boundary.findExternalWorkspaceReferences).toBeTypeOf("function");
    expect(
      boundary.findExternalWorkspaceReferences([
        {
          content:
            'import config from "/Users/example/plans-and-presentations/shared.js";',
          path: "packages/example/src/index.ts",
        },
        {
          content: 'export const local = "../../core/src/index.js";',
          path: "packages/example/src/local.ts",
        },
      ]),
    ).toEqual([
      {
        path: "packages/example/src/index.ts",
        reason: "design-reference repository",
      },
    ]);
  });

  it("accepts paths that stay inside the workbench", async () => {
    const boundary = await import("./check-workspace-boundary.mjs");

    expect(
      boundary.findExternalWorkspaceReferences([
        {
          content: 'import config from "../../core/src/index.js";',
          path: "packages/example/src/index.ts",
        },
      ]),
    ).toEqual([]);
  });

  it("rejects absolute, dependency-scheme, and escaping references", async () => {
    const boundary = await import("./check-workspace-boundary.mjs");

    expect(
      boundary.findExternalWorkspaceReferences(
        [
          {
            content: 'import value from "/tmp/outside.js";',
            path: "packages/absolute/src/index.ts",
          },
          {
            content: '{"dependencies":{"outside":"file:/tmp/outside"}}',
            path: "packages/file-dependency/package.json",
          },
          {
            content: '{"dependencies":{"outside":"link:../../../../outside"}}',
            path: "packages/link-dependency/package.json",
          },
          {
            content: 'export { value } from "../../../../outside.js";',
            path: "packages/relative/src/index.ts",
          },
          {
            content: 'import value from "C:\\\\outside\\\\index.js";',
            path: "packages/windows/src/index.ts",
          },
          {
            content: 'import value from "\\\\\\\\server\\\\share\\\\index.js";',
            path: "packages/unc/src/index.ts",
          },
        ],
        { workspaceRoot: "/workspace" },
      ),
    ).toEqual([
      { path: "packages/absolute/src/index.ts", reason: "absolute path" },
      {
        path: "packages/file-dependency/package.json",
        reason: "absolute path",
      },
      {
        path: "packages/link-dependency/package.json",
        reason: "workspace escape",
      },
      {
        path: "packages/relative/src/index.ts",
        reason: "workspace escape",
      },
      { path: "packages/windows/src/index.ts", reason: "absolute path" },
      { path: "packages/unc/src/index.ts", reason: "absolute path" },
    ]);
  });

  it("rejects a reference whose canonical path escapes through a symlink", async () => {
    const boundary = await import("./check-workspace-boundary.mjs");

    expect(
      boundary.findExternalWorkspaceReferences(
        [
          {
            content: 'import value from "./linked/index.js";',
            path: "packages/example/src/index.ts",
          },
        ],
        {
          canonicalize: () => "/outside/index.js",
          workspaceRoot: "/workspace",
        },
      ),
    ).toEqual([
      {
        path: "packages/example/src/index.ts",
        reason: "symlink escape",
      },
    ]);
  });

  it("resolves pnpm lockfile links from their importer directories", async () => {
    const boundary = await import("./check-workspace-boundary.mjs");
    const lockfile = (version) => `
importers:
  packages/scanner:
    dependencies:
      "@dvw/core":
        specifier: workspace:*
        version: ${version}
`;

    expect(
      boundary.findExternalWorkspaceReferences(
        [{ content: lockfile("link:../core"), path: "pnpm-lock.yaml" }],
        { workspaceRoot: "/workspace" },
      ),
    ).toEqual([]);
    expect(
      boundary.findExternalWorkspaceReferences(
        [
          {
            content: lockfile("link:../../../outside"),
            path: "pnpm-lock.yaml",
          },
        ],
        { workspaceRoot: "/workspace" },
      ),
    ).toEqual([{ path: "pnpm-lock.yaml", reason: "workspace escape" }]);
  });

  it("finds no external dependency in the actual product files", async () => {
    const boundary = await import("./check-workspace-boundary.mjs");

    expect(boundary.scanWorkspace(process.cwd())).toEqual([]);
  });
});
