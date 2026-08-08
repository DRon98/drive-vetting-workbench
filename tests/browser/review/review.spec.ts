import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  generateReviewArtifact,
  writeReviewArtifactCreateOnly,
  type ReviewArtifactInput,
} from "@dvw/review-artifact";

const workspaceRoot = resolve(process.cwd());
const fixtureRoot = join(workspaceRoot, "artifacts/local/review");
const evidenceRoot = join(workspaceRoot, "artifacts/local/review-browser");
const desktopRoot = join(evidenceRoot, "desktop");
const mobileRoot = join(evidenceRoot, "mobile");
const tabNames = [
  "Overview",
  "Drive Map",
  "Proposed Changes",
  "Questions",
  "Feedback Packet",
  "Receipts and Sources",
] as const;
const tabSlugs = [
  "overview",
  "drive-map",
  "changes",
  "questions",
  "feedback",
  "sources",
] as const;

interface AccessibilityEntry {
  readonly tab: string;
  readonly violations: readonly unknown[];
}

interface NetworkEntry {
  readonly label: string;
  readonly resourceType: string;
  readonly url: string;
}

const accessibility: AccessibilityEntry[] = [];
const requests: NetworkEntry[] = [];

function embeddedInput(path: string): ReviewArtifactInput {
  const html = readFileSync(path, "utf8");
  const raw = html.match(
    /<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/u,
  )?.[1];
  if (raw === undefined)
    throw new Error("Review fixture has no embedded data.");
  const parsed = JSON.parse(raw) as { review: ReviewArtifactInput };
  return parsed.review;
}

function fixturePath(): string {
  const candidates = readdirSync(fixtureRoot)
    .filter((name) =>
      /^review-[a-f0-9]{64}-round-1-[a-f0-9]{64}\.html$/u.test(name),
    )
    .map((name) => join(fixtureRoot, name))
    .filter(
      (path) =>
        embeddedInput(path).sourceSnapshot.startsWith(
          "Drive Lab messy-paisano snapshot 50c918e393ab",
        ) &&
        generateReviewArtifact(embeddedInput(path)).html ===
          readFileSync(path, "utf8"),
    )
    .sort();
  const path = candidates.at(-1);
  if (path === undefined)
    throw new Error("The Drive Lab review fixture is missing.");
  return path;
}

function injectionPath(): string {
  const source = fixturePath();
  const input = structuredClone(embeddedInput(source));
  const hostile =
    '</script><script data-attack="yes">globalThis.pwned = true</script><img src=x onerror=alert(1)>';
  input.title = hostile;
  input.nextHumanAction = hostile;
  const node = input.nodes.find(
    (candidate) => candidate.id === "messy-invoice-draft",
  );
  if (node === undefined) throw new Error("Injection target is missing.");
  node.name = hostile;
  node.evidence[0] = { ...node.evidence[0]!, value: hostile };
  input.sources[0] = { ...input.sources[0]!, claim: hostile };
  const generated = generateReviewArtifact(input);
  const path = join(evidenceRoot, `injection-${generated.htmlSha256}.html`);
  writeReviewArtifactCreateOnly(path, input);
  return path;
}

function auditNetwork(page: Page, label: string): void {
  page.on("request", (request) => {
    requests.push({
      label,
      resourceType: request.resourceType(),
      url: request.url(),
    });
  });
}

async function openArtifact(
  page: Page,
  path: string,
  label: string,
): Promise<void> {
  auditNetwork(page, label);
  await page.route(/^(?:https?|wss?):/u, (route) =>
    route.abort("blockedbyclient"),
  );
  await page.goto(pathToFileURL(path).href, { waitUntil: "load" });
  await expect(page.locator(".hero h1")).toBeVisible();
}

async function activateTab(page: Page, name: (typeof tabNames)[number]) {
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const panel = page.getByRole("tabpanel", { name });
  await expect(panel).toBeVisible();
  return panel;
}

test.beforeAll(() => {
  mkdirSync(desktopRoot, { recursive: true });
  mkdirSync(mobileRoot, { recursive: true });
});

test.afterAll(() => {
  const networkRequests = requests.filter((entry) =>
    /^(?:https?|wss?):/u.test(entry.url),
  );
  writeFileSync(
    join(evidenceRoot, "zero-network.json"),
    `${JSON.stringify({ networkRequestCount: networkRequests.length, networkRequests, requests }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(evidenceRoot, "accessibility.json"),
    `${JSON.stringify(
      {
        auditedTabs: accessibility.length,
        violationCount: accessibility.reduce(
          (count, entry) => count + entry.violations.length,
          0,
        ),
        results: accessibility,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  expect(networkRequests).toEqual([]);
});

test("captures every desktop tab and an accessibility report", async ({
  page,
}) => {
  await openArtifact(page, fixturePath(), "desktop-tabs");
  await page.locator(".hero").screenshot({
    animations: "disabled",
    path: join(desktopRoot, "hero.png"),
  });
  for (const [index, name] of tabNames.entries()) {
    await activateTab(page, name);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    accessibility.push({ tab: tabSlugs[index]!, violations: axe.violations });
    expect(axe.violations, `${name} accessibility violations`).toEqual([]);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: join(desktopRoot, `${tabSlugs[index]}.png`),
    });
  }
  const remoteAttributes = await page
    .locator("[href], [src]")
    .evaluateAll((nodes) =>
      nodes
        .map(
          (node) => node.getAttribute("href") ?? node.getAttribute("src") ?? "",
        )
        .filter((value) => /^(?:https?|wss?):/u.test(value)),
    );
  expect(remoteAttributes).toEqual([]);
});

test("supports keyboard tabs, node focus, and local review controls", async ({
  page,
}) => {
  const sourcePath = fixturePath();
  const sourceInput = embeddedInput(sourcePath);
  await openArtifact(page, sourcePath, "keyboard-feedback");
  const liveRegion = page.locator("[data-review-live]");
  expect(
    await liveRegion.evaluate((element) => getComputedStyle(element).clipPath),
  ).toBe("inset(50%)");
  const overview = page.getByRole("tab", { name: "Overview", exact: true });
  await overview.focus();
  await overview.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Drive Map", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const map = page.locator(".figure-shell");
  await map.screenshot({
    animations: "disabled",
    path: join(desktopRoot, "drive-map-default.png"),
  });
  const invoiceNode = page.getByRole("button", {
    name: /Hotel Paisano Invoice draft FINAL\.pdf/u,
  });
  await invoiceNode.focus();
  await invoiceNode.press("Enter");
  await expect(invoiceNode).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator('.node-detail.is-active:not([data-node-detail="all"])'),
  ).toBeVisible();
  await map.screenshot({
    animations: "disabled",
    path: join(desktopRoot, "drive-map-focused.png"),
  });

  await activateTab(page, "Proposed Changes");
  const firstAction = page.locator("[data-action-review]").first();
  await firstAction.getByRole("button", { name: "Edit", exact: true }).click();
  await firstAction
    .locator("[data-action-edit]")
    .fill("2026-08-02 - Hotel Paisano - Invoice.pdf");
  await firstAction.locator("[data-action-comment]").fill("Use the body date.");
  await activateTab(page, "Questions");
  await page.getByLabel("Observed modified date", { exact: true }).check();
  await page
    .locator("[data-question-comment]")
    .fill("Confirm against the invoice body.");
  await activateTab(page, "Feedback Packet");
  await page
    .locator("[data-global-comment]")
    .fill("Return a revised plan for review.");
  const preview = page.locator("[data-feedback-preview]");
  await expect(preview).toContainText(
    "2026-08-02 - Hotel Paisano - Invoice.pdf",
  );
  await expect(preview).toContainText("Return a revised plan for review.");
  await expect(preview).toContainText(
    `"actionId": "${sourceInput.plan.actions[0]?.actionId}"`,
  );
  await expect(preview).toContainText(
    '"questionKey": "question-messy-invoice-date-source"',
  );
  await expect(preview).toContainText('"answer": "Observed modified date"');
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(desktopRoot, "feedback-edited.png"),
  });
});

test("captures every mobile tab", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openArtifact(page, fixturePath(), "mobile-tabs");
  for (const [index, name] of tabNames.entries()) {
    await activateTab(page, name);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: join(mobileRoot, `${tabSlugs[index]}.png`),
    });
  }
});

test("expands every panel for print and honors reduced motion", async ({
  page,
}) => {
  await openArtifact(page, fixturePath(), "print-reduced-motion");
  await page.emulateMedia({ media: "print" });
  for (const panel of await page.getByRole("tabpanel").all()) {
    await expect(panel).toBeVisible();
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(evidenceRoot, "print.png"),
  });
  await page.pdf({
    format: "Letter",
    path: join(evidenceRoot, "review-print.pdf"),
    printBackground: true,
  });
  await page.emulateMedia({ media: "screen", reducedMotion: "reduce" });
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(evidenceRoot, "reduced-motion.png"),
  });
});

test("keeps injected markup inert in the live DOM", async ({ page }) => {
  await openArtifact(page, injectionPath(), "injection");
  expect(await page.locator('script[data-attack="yes"]').count()).toBe(0);
  expect(await page.locator("img").count()).toBe(0);
  expect(await page.locator("[onerror]").count()).toBe(0);
  expect(
    await page.evaluate(() =>
      Object.prototype.hasOwnProperty.call(globalThis, "pwned"),
    ),
  ).toBe(false);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(evidenceRoot, "injection-inert.png"),
  });
});
