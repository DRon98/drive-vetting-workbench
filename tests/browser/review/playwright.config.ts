import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 5_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: fileURLToPath(
    new URL(
      "../../../artifacts/local/review-browser/test-results",
      import.meta.url,
    ),
  ),
  reporter: [["line"]],
  retries: 0,
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "review.spec.ts",
  timeout: 30_000,
  use: {
    browserName: "chromium",
    headless: true,
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  },
  workers: 1,
});
