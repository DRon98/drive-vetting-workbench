import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("local secret boundaries", () => {
  it("keeps common local credential locations out of Git", () => {
    const paths = [
      ".credentials/write.json",
      ".tokens/read.json",
      "client-secret-local.json",
      "oauth-local.json",
    ];
    const result = spawnSync("git", ["check-ignore", "--stdin"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: `${paths.join("\n")}\n`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(paths);
  });
});
