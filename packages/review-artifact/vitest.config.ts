import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dvw/change-planner": fileURLToPath(
        new URL("../change-planner/src/index.ts", import.meta.url),
      ),
      "@dvw/core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
      "@dvw/feedback": fileURLToPath(
        new URL("../feedback/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
