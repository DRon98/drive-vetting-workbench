import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dvw/change-planner": new URL(
        "../../packages/change-planner/src/index.ts",
        import.meta.url,
      ).pathname,
      "@dvw/core": new URL("../../packages/core/src/index.ts", import.meta.url)
        .pathname,
      "@dvw/decision-memory": new URL(
        "../../packages/decision-memory/src/index.ts",
        import.meta.url,
      ).pathname,
      "@dvw/drive-simulator": new URL(
        "../../packages/drive-simulator/src/index.ts",
        import.meta.url,
      ).pathname,
      "@dvw/evidence-builder": new URL(
        "../../packages/evidence-builder/src/index.ts",
        import.meta.url,
      ).pathname,
      "@dvw/evidence-store-sqlite": new URL(
        "../../packages/evidence-store-sqlite/src/index.ts",
        import.meta.url,
      ).pathname,
      "@dvw/policy-engine": new URL(
        "../../packages/policy-engine/src/index.ts",
        import.meta.url,
      ).pathname,
      "@dvw/reasoning": new URL(
        "../../packages/reasoning/src/index.ts",
        import.meta.url,
      ).pathname,
      "@dvw/review-artifact": new URL(
        "../../packages/review-artifact/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
