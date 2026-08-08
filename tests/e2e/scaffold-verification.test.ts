import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("scaffold verification commands", () => {
  it.each(["smoke:sqlite", "check:workspace-boundary"])(
    "runs %s from the repository root",
    (scriptName) => {
      const result = spawnSync("pnpm", [scriptName], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    },
  );
});
