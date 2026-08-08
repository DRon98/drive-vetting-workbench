import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace layout", () => {
  it("discovers application and package workspaces", () => {
    const workspace = readFileSync(
      new URL("../../../pnpm-workspace.yaml", import.meta.url),
      "utf8",
    );

    expect(workspace).toContain("- apps/*");
    expect(workspace).toContain("- packages/*");
  });
});
