import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { buildReviewFixture } from "../../../apps/review-preview/src/fixture.js";
import {
  createReviewFeedbackPacket,
  feedbackChecksum,
  feedbackContextFromReview,
  parseReviewFeedbackPacket,
  replanFromReviewFeedback,
  serializeReviewFeedbackPacket,
  type ReviewFeedbackPacket,
} from "@dvw/feedback";
import {
  ReviewArtifactInputSchema,
  generateReviewArtifact,
  writeReviewArtifactCreateOnly,
  type ReviewArtifactInput,
} from "@dvw/review-artifact";

const workspaceRoot = resolve(process.cwd());
const fixtureRoot = join(workspaceRoot, "artifacts/local/feedback/fixture");
const labRoot = join(workspaceRoot, "artifacts/local/feedback/lab");
const evidenceRoot = join(workspaceRoot, "artifacts/local/feedback-browser");
const packetRoot = join(evidenceRoot, "packets");
const screenshotsRoot = join(evidenceRoot, "screenshots");

let sourceInput: ReviewArtifactInput;
let sourcePath: string;
let importedPacket: ReviewFeedbackPacket;
let regeneratedInput: ReviewArtifactInput;
let regeneratedPath: string;
const requests: { label: string; resourceType: string; url: string }[] = [];

function writeCreateOnly(path: string, value: string): void {
  try {
    writeFileSync(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST" ||
      readFileSync(path, "utf8") !== value
    ) {
      throw error;
    }
  }
}

function prepareArtifacts(): void {
  mkdirSync(fixtureRoot, { recursive: true });
  mkdirSync(packetRoot, { recursive: true });
  mkdirSync(screenshotsRoot, { recursive: true });
  const built = buildReviewFixture({ artifactRoot: fixtureRoot, labRoot });
  sourceInput = built.input;
  sourcePath = built.artifactPath;
  const action = sourceInput.plan.actions[0];
  const question = sourceInput.questions[0];
  if (action === undefined || question === undefined) {
    throw new Error("Feedback browser fixture is incomplete.");
  }
  importedPacket = createReviewFeedbackPacket(
    feedbackContextFromReview(sourceInput),
    {
      actions: [
        {
          actionId: action.actionId,
          comment: "Browser fixture action comment.",
          disposition: "Edit",
          proposedName: "2026-08-02 - Hotel Paisano - Paid Invoice.pdf",
          reason: {
            code: "PAID_DATE_CONFIRMED",
            detail: "Browser fixture structured reason.",
          },
        },
      ],
      globalComment: "Browser fixture global comment; feedback only.",
      questions: [
        {
          answer: question.choices[0]!,
          comment: "Browser fixture question comment.",
          questionKey: question.questionKey,
          scope: question.scope,
        },
      ],
    },
    {
      exportedAt: "2026-08-08T16:00:00.000Z",
      reviewer: "Buck reviewer",
    },
  );
  const replanned = replanFromReviewFeedback(sourceInput, importedPacket);
  regeneratedInput = ReviewArtifactInputSchema.parse({
    ...sourceInput,
    feedbackSummary: {
      importedChecksum: importedPacket.checksum,
      nextPlanHash: replanned.plan.planHash,
      nextReviewRound: replanned.reviewRound,
      sourcePlanHash: replanned.sourcePlanHash,
      sourceReviewRound: sourceInput.reviewRound,
    },
    generatedAt: "2026-08-08T16:01:00.000Z",
    importedFeedback: importedPacket,
    nextHumanAction: "Review the feedback-driven proposal; no approval exists.",
    plan: replanned.plan,
    reviewRound: replanned.reviewRound,
  });
  const generated = generateReviewArtifact(regeneratedInput);
  const contentAddressedPath = join(
    fixtureRoot,
    `review-${regeneratedInput.plan.planHash}-round-${regeneratedInput.reviewRound}-${generated.htmlSha256}.html`,
  );
  const exact = writeReviewArtifactCreateOnly(
    contentAddressedPath,
    regeneratedInput,
  );
  expect(exact.htmlSha256).toBe(generated.htmlSha256);
  regeneratedPath = contentAddressedPath;
  writeCreateOnly(
    join(packetRoot, `feedback-${importedPacket.checksum}.json`),
    serializeReviewFeedbackPacket(importedPacket),
  );
}

async function installClipboardFallback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: () => Promise.reject(new Error("test read fallback")),
        writeText: () => Promise.reject(new Error("test write fallback")),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: (command: string) => {
        if (command !== "copy") return false;
        (
          globalThis as typeof globalThis & { __fallbackCopied?: string }
        ).__fallbackCopied = (document.activeElement as HTMLTextAreaElement)
          ?.value;
        return true;
      },
    });
  });
}

async function openArtifact(page: Page, path: string, label: string) {
  page.on("request", (request) => {
    requests.push({
      label,
      resourceType: request.resourceType(),
      url: request.url(),
    });
  });
  await page.route(/^(?:https?|wss?):/u, (route) =>
    route.abort("blockedbyclient"),
  );
  await page.goto(pathToFileURL(path).href, { waitUntil: "load" });
  await expect(page.locator(".hero h1")).toBeVisible();
}

async function tab(page: Page, name: string) {
  const control = page.getByRole("tab", { name, exact: true });
  await control.click();
  const panel = page.getByRole("tabpanel", { name });
  await expect(panel).toBeVisible();
  return panel;
}

async function clearDraft(page: Page): Promise<void> {
  await tab(page, "Feedback Packet");
  await page.getByRole("button", { name: "Clear local draft" }).click();
}

async function fillSourceReview(page: Page): Promise<void> {
  await clearDraft(page);
  await tab(page, "Proposed Changes");
  const action = page.locator("[data-action-review]").first();
  await action.getByRole("button", { name: "Edit", exact: true }).click();
  await action
    .locator("[data-action-edit]")
    .fill("2026-08-02 - Hotel Paisano - Paid Invoice.pdf");
  await action.locator("[data-action-reason-code]").fill("PAID_DATE_CONFIRMED");
  await action
    .locator("[data-action-reason-detail]")
    .fill("Browser fixture structured reason.");
  await action
    .locator("[data-action-comment]")
    .fill("Browser fixture action comment.");
  await tab(page, "Questions");
  await page
    .locator("[data-question-comment]")
    .fill("Browser fixture question comment.");
  await tab(page, "Feedback Packet");
  await page.locator("[data-reviewer]").fill("Buck reviewer");
  await page
    .locator("[data-global-comment]")
    .fill("Browser fixture global comment; feedback only.");
}

async function fallbackText(page: Page): Promise<string> {
  const value = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { __fallbackCopied?: string })
        .__fallbackCopied,
  );
  if (value === undefined) throw new Error("Clipboard fallback did not run.");
  return value;
}

function withChecksum(value: ReviewFeedbackPacket): string {
  const payload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "checksum"),
  ) as Omit<ReviewFeedbackPacket, "checksum">;
  return JSON.stringify({ ...payload, checksum: feedbackChecksum(payload) });
}

test.beforeAll(() => prepareArtifacts());

test.afterAll(() => {
  const remote = requests.filter((entry) =>
    /^(?:https?|wss?):/u.test(entry.url),
  );
  writeFileSync(
    join(evidenceRoot, "zero-network.json"),
    `${JSON.stringify({ remoteRequestCount: remote.length, remote, requests }, null, 2)}\n`,
    "utf8",
  );
  expect(remote).toEqual([]);
});

test("exports through the clipboard fallback and round-trips paste, import, download, and local draft", async ({
  page,
}) => {
  await installClipboardFallback(page);
  await openArtifact(page, sourcePath, "source-roundtrip");
  await fillSourceReview(page);
  await page.getByRole("button", { name: "Copy packet" }).click();
  await expect(page.locator("[data-review-live]")).toContainText(
    "packet copied",
  );
  const firstText = await fallbackText(page);
  const firstPacket = parseReviewFeedbackPacket(
    firstText,
    feedbackContextFromReview(sourceInput),
  );
  expect(firstPacket).toMatchObject({
    actions: importedPacket.actions,
    globalComment: importedPacket.globalComment,
    questions: importedPacket.questions,
    reviewer: importedPacket.reviewer,
  });

  await page
    .locator("[data-feedback-import]")
    .fill(`\`\`\`json\n${firstText}\`\`\``);
  await page.getByRole("button", { name: "Preview packet" }).click();
  await expect(page.locator("[data-import-report]")).toContainText(
    "Valid round-trip preview",
  );
  await expect(page.locator("[data-import-report]")).toContainText(
    "Rejected fields (0)",
  );
  await page.getByRole("button", { name: "Import packet" }).click();
  await expect(page.locator("[data-review-live]")).toContainText(
    "imported losslessly",
  );
  await page.getByRole("button", { name: "Copy packet" }).click();
  expect(await fallbackText(page)).toBe(firstText);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download packet" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    `feedback-${sourceInput.plan.planHash}-round-1-${firstPacket.checksum}.json`,
  );
  expect(readFileSync(await download.path(), "utf8")).toBe(firstText);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(screenshotsRoot, "valid-roundtrip.png"),
  });

  await page.reload({ waitUntil: "load" });
  await tab(page, "Feedback Packet");
  await expect(page.locator("[data-reviewer]")).toHaveValue("Buck reviewer");
  await page.getByRole("button", { name: "Clear local draft" }).click();
  await page.reload({ waitUntil: "load" });
  await tab(page, "Feedback Packet");
  await expect(page.locator("[data-reviewer]")).toHaveValue("");
});

test("blocks stale and executable packets with precise fields", async ({
  page,
}) => {
  await installClipboardFallback(page);
  await openArtifact(page, sourcePath, "invalid-packets");
  await clearDraft(page);
  const stale = structuredClone(importedPacket);
  stale.planHash = "b".repeat(64);
  await page.locator("[data-feedback-import]").fill(withChecksum(stale));
  await page.getByRole("button", { name: "Preview packet" }).click();
  await expect(page.locator("[data-import-report]")).toContainText("planHash");
  await expect(
    page.getByRole("button", { name: "Import packet" }),
  ).toBeDisabled();

  const hostile = structuredClone(importedPacket);
  hostile.globalComment = "<img src=x onerror=alert(1)>";
  await page.locator("[data-feedback-import]").fill(withChecksum(hostile));
  await page.getByRole("button", { name: "Preview packet" }).click();
  await expect(page.locator("[data-import-report]")).toContainText(
    "globalComment",
  );
  await expect(page.locator("[data-import-report]")).toContainText(
    "Markup is not allowed",
  );
  await expect(
    page.locator("[data-import-report] li").filter({
      hasText: "globalComment: Markup is not allowed.",
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Import packet" }),
  ).toBeDisabled();

  const invalidValue = structuredClone(importedPacket);
  invalidValue.actions[0]!.comment = 42 as unknown as string;
  await page.locator("[data-feedback-import]").fill(withChecksum(invalidValue));
  await page.getByRole("button", { name: "Preview packet" }).click();
  await expect(page.locator("[data-import-report]")).toContainText(
    "actions.0.comment",
  );
  await expect(
    page.getByRole("button", { name: "Import packet" }),
  ).toBeDisabled();
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(screenshotsRoot, "blocked-injection.png"),
  });
  expect(
    await page.evaluate(() => (globalThis as { pwned?: boolean }).pwned),
  ).toBeUndefined();
});

test("accepts file import and a new packet pasted into regenerated HTML", async ({
  page,
}) => {
  await installClipboardFallback(page);
  await openArtifact(page, sourcePath, "file-import");
  await clearDraft(page);
  await page
    .locator("[data-import-file]")
    .setInputFiles(
      join(packetRoot, `feedback-${importedPacket.checksum}.json`),
    );
  await page.getByRole("button", { name: "Preview packet" }).click();
  await expect(page.locator("[data-import-report]")).toContainText(
    "Valid round-trip preview",
  );
  await page.getByRole("button", { name: "Import packet" }).click();
  await expect(page.locator("[data-global-comment]")).toHaveValue(
    importedPacket.globalComment,
  );

  await page.goto(pathToFileURL(regeneratedPath).href, { waitUntil: "load" });
  await tab(page, "Feedback Packet");
  await expect(page.locator("[data-imported-feedback]")).toContainText(
    importedPacket.globalComment,
  );
  await expect(page.locator(".feedback-history")).toContainText(
    regeneratedInput.feedbackSummary!.sourcePlanHash,
  );
  await clearDraft(page);
  await tab(page, "Proposed Changes");
  const action = page.locator("[data-action-review]").first();
  await action.getByRole("button", { name: "Accept", exact: true }).click();
  await action.locator("[data-action-reason-code]").fill("ROUND_TWO_ACCEPT");
  await action
    .locator("[data-action-reason-detail]")
    .fill("Keep this as review feedback only.");
  await tab(page, "Feedback Packet");
  await page.locator("[data-reviewer]").fill("Second reviewer");
  await page.getByRole("button", { name: "Copy packet" }).click();
  const roundTwoText = await fallbackText(page);
  const roundTwo = parseReviewFeedbackPacket(
    roundTwoText,
    feedbackContextFromReview(regeneratedInput),
  );
  expect(roundTwo.reviewRound).toBe(2);
  expect(roundTwo.planHash).toBe(regeneratedInput.plan.planHash);
  await page.locator("[data-feedback-import]").fill(roundTwoText);
  await page.getByRole("button", { name: "Preview packet" }).click();
  await page.getByRole("button", { name: "Import packet" }).click();
  await page.getByRole("button", { name: "Copy packet" }).click();
  expect(await fallbackText(page)).toBe(roundTwoText);

  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(screenshotsRoot, "regenerated-roundtrip.png"),
  });
});
