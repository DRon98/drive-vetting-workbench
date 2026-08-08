import { defineConfig, devices } from "@playwright/test";
import { join, resolve } from "node:path";

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: false,
  outputDir: join(
    resolve(process.cwd()),
    "artifacts/local/feedback-browser/test-results",
  ),
  reporter: "line",
  testDir: ".",
  testMatch: "feedback.spec.ts",
  timeout: 45_000,
  use: {
    ...devices["Desktop Chrome"],
    locale: "en-US",
    timezoneId: "America/New_York",
  },
  workers: 1,
});
