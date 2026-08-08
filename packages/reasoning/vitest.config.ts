import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dvw/core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
      "@dvw/evidence-builder": fileURLToPath(
        new URL("../evidence-builder/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
