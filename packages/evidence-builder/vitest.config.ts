import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dvw/core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
      "@dvw/evidence-store-sqlite": fileURLToPath(
        new URL("../evidence-store-sqlite/src/index.ts", import.meta.url),
      ),
      "@dvw/policy-engine": fileURLToPath(
        new URL("../policy-engine/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
