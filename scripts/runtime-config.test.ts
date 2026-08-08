import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface RuntimeConfig {
  nativeBuildRequired: boolean;
  nodeMajor: number;
  sqliteDriver: string;
}

describe("runtime configuration", () => {
  it("records the supported Node line and built-in SQLite choice", () => {
    const config = JSON.parse(
      readFileSync(new URL("./runtime-config.json", import.meta.url), "utf8"),
    ) as RuntimeConfig;

    expect(config).toEqual({
      nativeBuildRequired: false,
      nodeMajor: 24,
      sqliteDriver: "node:sqlite",
    });
  });

  it("runs the SQLite smoke check without an experimental warning", () => {
    const result = spawnSync("pnpm", ["smoke:sqlite"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("node:sqlite smoke check passed");
    expect(result.stderr).not.toContain("ExperimentalWarning:");
  });
});
