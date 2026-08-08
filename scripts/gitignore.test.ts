import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("repository ignore policy", () => {
  it("excludes generated state and credential-shaped files", () => {
    const paths = [
      "tsconfig.tsbuildinfo",
      ".dvw/evidence.db",
      "evidence.sqlite",
      "evidence.sqlite-wal",
      "receipts/local/run.json",
      "oauth-user.json",
      "client-secret-local.json",
      ".tokens/read-token.json",
      ".credentials/write-credential.json",
    ];
    const result = spawnSync("git", ["check-ignore", "--stdin"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: `${paths.join("\n")}\n`,
    });
    const ignoredPaths = result.stdout.trim().split("\n");

    expect(result.status).toBe(0);
    expect(ignoredPaths).toEqual(paths);
  });
});
