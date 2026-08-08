import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./vitest.workspace-aliases.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    include: ["tests/e2e/**/*.test.ts", "tests/browser/**/*.test.ts"],
  },
});
