import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createReviewFeedbackPacket,
  feedbackContextFromReview,
  replanFromReviewFeedback,
} from "@dvw/feedback";
import {
  REVIEW_TABS,
  ReviewArtifactInputSchema,
  generateReviewArtifact,
  writeReviewArtifactCreateOnly,
  type ReviewArtifactInput,
} from "./index.js";

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dvw-review-artifact-"));
  return join(directory, "nested", "review.html");
}

function reviewInput(injection = false): ReviewArtifactInput {
  const hostile = injection
    ? '</script><script data-attack="yes">globalThis.pwned = true</script><img src=x onerror=alert(1)>'
    : "Hotel Paisano Invoice draft FINAL.pdf";
  const policyVersion = "1.0.0";
  const scanGeneration = "scan-review-1";
  const rename = {
    actionId: "act-review-rename",
    confidence: 0.93,
    desiredState: { name: "2026-08-01 - Hotel Paisano - Invoice.pdf" },
    evidenceIds: ["evidence-invoice-name"],
    policyVersion,
    preconditions: {
      modifiedTime: "2026-08-08T12:00:00.000Z",
      name: hostile,
      parentIds: ["review-root"],
      permissions: { canRead: true, canWrite: true },
      shortcutTargetId: null,
      trashed: false,
    },
    reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
    reviewState: "Blocked" as const,
    scanGeneration,
    targetId: "review-invoice",
    type: "RENAME" as const,
  };
  const keep = {
    actionId: "act-review-keep",
    confidence: 1,
    desiredState: { name: "Signed Original.pdf", parentIds: ["review-root"] },
    evidenceIds: ["evidence-original-protected"],
    policyVersion,
    preconditions: {
      modifiedTime: "2026-08-08T12:00:00.000Z",
      name: "Signed Original.pdf",
      parentIds: ["review-root"],
      permissions: { canRead: true, canWrite: false },
      shortcutTargetId: null,
      trashed: false,
    },
    reasonCode: "PAISANO.PROTECTED.LEGAL_ORIGINAL",
    reviewState: "Blocked" as const,
    scanGeneration,
    targetId: "review-original",
    type: "KEEP" as const,
  };
  return {
    artifactVersion: "dvw.review.v1",
    coverage: {
      complete: false,
      deniedItemCount: 1,
      itemCount: 3,
      pageCount: 2,
      sourceLocator: "scan:scan-review-1#coverage",
      warningCount: 1,
    },
    generatedAt: "2026-08-08T14:30:00.000Z",
    glossary: [
      {
        definition: "The immutable digest that identifies one exact plan.",
        sourceLocator: "contract:ChangePlan#planHash",
        term: "plan hash",
      },
      {
        definition: "A Drive reference that leaves the source item in place.",
        sourceLocator: "policy:paisano#shortcuts",
        term: "shortcut",
      },
    ],
    nextHumanAction: injection
      ? hostile
      : "Resolve the permission gap, then review each proposed action.",
    nodes: [
      {
        canRead: true,
        canWrite: true,
        depth: 0,
        evidence: [],
        id: "review-root",
        mimeType: "application/vnd.google-apps.folder",
        name: "Messy Paisano",
        parentIds: [],
        policies: [],
        protected: false,
        shortcutTargetId: null,
        sourceLocator: "drive:item:review-root",
      },
      {
        canRead: true,
        canWrite: true,
        depth: 1,
        evidence: [
          {
            id: "evidence-invoice-name",
            kind: "Observed",
            label: "Observed file name",
            sourceLocator: "drive:item:review-invoice#name",
            value: hostile,
          },
        ],
        id: "review-invoice",
        mimeType: "application/pdf",
        name: hostile,
        parentIds: ["review-root"],
        policies: [
          {
            reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
            sourceLocator: "paisano:1.0.0/naming.json#invoice",
            summary: injection ? hostile : "Use the dated deal-document name.",
          },
        ],
        protected: false,
        shortcutTargetId: null,
        sourceLocator: "drive:item:review-invoice",
      },
      {
        canRead: true,
        canWrite: false,
        depth: 1,
        evidence: [
          {
            id: "evidence-original-protected",
            kind: "Policy",
            label: "Protected legal original",
            sourceLocator: "paisano:1.0.0/protected-items.json#legal-original",
            value: "Do not rename the signed original.",
          },
        ],
        id: "review-original",
        mimeType: "application/pdf",
        name: "Signed Original.pdf",
        parentIds: ["review-root"],
        policies: [
          {
            reasonCode: "PAISANO.PROTECTED.LEGAL_ORIGINAL",
            sourceLocator: "paisano:1.0.0/protected-items.json#legal-original",
            summary: "Keep the legal original unchanged.",
          },
        ],
        protected: true,
        shortcutTargetId: null,
        sourceLocator: "drive:item:review-original",
      },
    ],
    plan: {
      actions: [rename, keep],
      approvalEligible: false,
      blockers: [
        {
          actionIds: [rename.actionId],
          blockerId: "blk-review-permission",
          code: "PERMISSION_GAP",
          evidenceIds: ["evidence-invoice-name"],
          message: injection
            ? hostile
            : "The target needs write permission before a rename.",
          targetIds: [rename.targetId],
        },
      ],
      canonicalJson: "{}",
      effectiveActions: [],
      explanations: [
        {
          actionId: rename.actionId,
          summary: "Rename the invoice after the permission gap is resolved.",
          writeRequired: true,
        },
        {
          actionId: keep.actionId,
          summary: "Keep the signed original unchanged.",
          writeRequired: false,
        },
      ],
      hashContract: "dvw.change-plan.v1",
      planHash: "a".repeat(64),
      policyVersion,
      scanGeneration,
    },
    priorReceipts: [
      {
        runId: "run-fixture-1",
        sourceLocator: "receipt:run-fixture-1",
        status: "Verified",
        summary: "A prior synthetic rename was re-fetched and verified.",
      },
    ],
    questions: [
      {
        choices: ["Invoice date", "Modified date"],
        defaultChoice: "Invoice date",
        evidenceIds: ["evidence-invoice-name"],
        policyLocators: ["paisano:1.0.0/naming.json#invoice"],
        prompt: injection ? hostile : "Which date should the invoice name use?",
        questionKey: "question-review-date",
        scope: { id: "review-invoice", type: "item" },
      },
    ],
    reviewRound: 1,
    scope: {
      name: "Messy Paisano synthetic review",
      rootId: "review-root",
    },
    sourceSnapshot: "Drive Lab messy-paisano at snapshot 50c918e393ab",
    sources: [
      {
        claim: injection ? hostile : "The scan saw three synthetic items.",
        label: "Scan coverage",
        locator: "scan:scan-review-1#coverage",
      },
      {
        claim: "The plan contains two typed actions and one blocker.",
        label: "Change plan",
        locator: `plan:${"a".repeat(64)}`,
      },
    ],
    title: "Drive review: Messy Paisano",
  };
}

function hashForCsp(value: string): string {
  return createHash("sha256").update(value).digest("base64");
}

describe("self-contained review artifact", () => {
  test("renders all required panels, claims, review controls, and node details deterministically", () => {
    const input = ReviewArtifactInputSchema.parse(reviewInput());
    const first = generateReviewArtifact(input);
    const second = generateReviewArtifact(input);

    expect(second).toEqual(first);
    expect(first.html).toMatch(/^<!doctype html>/u);
    expect(first.htmlSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.manifest).toMatchObject({
      artifactVersion: "dvw.review.v1",
      includedPanels: REVIEW_TABS,
      planHash: input.plan.planHash,
      reviewRound: 1,
    });
    for (const tab of REVIEW_TABS) {
      expect(first.html).toContain(`data-tab="${tab}"`);
      expect(first.html).toContain(`data-panel="${tab}"`);
    }
    expect(first.html.match(/role="tab"/gu)).toHaveLength(REVIEW_TABS.length);
    expect(first.html.match(/role="tabpanel"/gu)).toHaveLength(
      REVIEW_TABS.length,
    );
    expect(first.html.match(/class="tree-node/gu)).toHaveLength(
      input.nodes.length,
    );
    expect(first.html.match(/class="node-detail/gu)).toHaveLength(
      input.nodes.length + 1,
    );
    expect(first.html.match(/data-review-action=/gu)).toHaveLength(
      input.plan.actions.length * 4,
    );
    expect(first.html).toContain('aria-live="polite"');
    expect(first.html).toContain("@media print");
    expect(first.html).toContain("prefers-reduced-motion: reduce");
    expect(first.html).toContain("Scan coverage");
    expect(first.html).toContain("Source ledger");
    expect(first.html).not.toMatch(/https?:\/\//u);
  });

  test("binds the inline stylesheet and executable controller to CSP hashes", () => {
    const artifact = generateReviewArtifact(reviewInput());
    const csp = artifact.html.match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/u,
    )?.[1];
    const style = artifact.html.match(/<style>([\s\S]*?)<\/style>/u)?.[1];
    const scripts = [
      ...artifact.html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/gu),
    ];
    const executable = scripts.at(-1)?.[1];
    expect(csp).toBeDefined();
    expect(style).toBeDefined();
    expect(executable).toBeDefined();
    if (csp === undefined || style === undefined || executable === undefined) {
      throw new Error("Missing CSP-bound assets.");
    }
    expect(csp).toContain(`style-src 'sha256-${hashForCsp(style)}'`);
    expect(csp).toContain(`script-src 'sha256-${hashForCsp(executable)}'`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  test("keeps hostile Drive and policy text inert in HTML and embedded JSON", () => {
    const input = reviewInput(true);
    const artifact = generateReviewArtifact(input);
    expect(artifact.html).not.toContain('<script data-attack="yes">');
    expect(artifact.html).not.toContain("<img src=x");
    expect(artifact.html).not.toContain("onerror=alert");
    expect(artifact.html).not.toContain("innerHTML");
    expect(artifact.html).not.toMatch(/\beval\s*\(/u);
    expect(artifact.html).toContain("&lt;/script&gt;");
    expect(artifact.html).toContain("\\u003c/script\\u003e");
    expect(artifact.html).not.toContain("globalThis.pwned = true");
    const embedded = artifact.html.match(
      /<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/u,
    )?.[1];
    expect(embedded).toBeDefined();
    if (embedded === undefined)
      throw new Error("Missing embedded review data.");
    const parsed = JSON.parse(embedded) as { review: ReviewArtifactInput };
    expect(parsed.review.nodes[1]?.name).toBe(input.nodes[1]?.name);
    expect(parsed.review.plan.actions[0]?.confidence).toBe(0.93);
  });

  test("rejects unknown input fields, invalid plans, duplicate nodes, and missing action targets", () => {
    const valid = reviewInput();
    expect(
      ReviewArtifactInputSchema.safeParse({ ...valid, unknown: true }).success,
    ).toBe(false);
    expect(
      ReviewArtifactInputSchema.safeParse({
        ...valid,
        plan: { ...valid.plan, planHash: "not-a-hash" },
      }).success,
    ).toBe(false);
    expect(
      ReviewArtifactInputSchema.safeParse({
        ...valid,
        nodes: [...valid.nodes, valid.nodes[0]],
      }).success,
    ).toBe(false);
    expect(
      ReviewArtifactInputSchema.safeParse({
        ...valid,
        nodes: valid.nodes.filter((node) => node.id !== "review-invoice"),
      }).success,
    ).toBe(false);
  });

  test("writes create-only and refuses to replace different artifact bytes", () => {
    const path = temporaryPath();
    const first = writeReviewArtifactCreateOnly(path, reviewInput());
    const repeated = writeReviewArtifactCreateOnly(path, reviewInput());
    expect(repeated).toEqual(first);
    expect(readFileSync(path, "utf8")).toBe(first.html);

    writeFileSync(path, "tampered", "utf8");
    expect(() => writeReviewArtifactCreateOnly(path, reviewInput())).toThrow(
      /replace|different|exists/u,
    );
    expect(readFileSync(path, "utf8")).toBe("tampered");
  });

  test("embeds imported feedback and a before-after replan summary without enabling approval", () => {
    const original = reviewInput();
    const context = feedbackContextFromReview(original);
    const packet = createReviewFeedbackPacket(
      context,
      {
        actions: original.plan.actions.map((action, index) => ({
          actionId: action.actionId,
          comment:
            index === 0 ? "Use the paid date." : "Keep remains protected.",
          disposition: index === 0 ? "Edit" : "Reject",
          proposedName:
            index === 0
              ? "2026-08-02 - Hotel Paisano - Paid Invoice.pdf"
              : null,
          reason: {
            code: index === 0 ? "PAID_DATE_CONFIRMED" : "NO_CHANGE",
            detail:
              index === 0
                ? "The paid stamp controls."
                : "No proposal is wanted.",
          },
        })),
        globalComment: "New review round only; not approval.",
        questions: original.questions.map((question) => ({
          answer: question.choices[0]!,
          comment: "Use the document value.",
          questionKey: question.questionKey,
          scope: question.scope,
        })),
      },
      {
        exportedAt: "2026-08-08T16:00:00.000Z",
        reviewer: "Buck reviewer",
      },
    );
    const replanned = replanFromReviewFeedback(original, packet);
    const regenerated = ReviewArtifactInputSchema.parse({
      ...original,
      feedbackSummary: {
        importedChecksum: packet.checksum,
        nextPlanHash: replanned.plan.planHash,
        nextReviewRound: replanned.reviewRound,
        sourcePlanHash: replanned.sourcePlanHash,
        sourceReviewRound: original.reviewRound,
      },
      generatedAt: "2026-08-08T16:01:00.000Z",
      importedFeedback: packet,
      plan: replanned.plan,
      reviewRound: replanned.reviewRound,
    });
    const artifact = generateReviewArtifact(regenerated);
    for (const label of [
      "Copy packet",
      "Download packet",
      "Paste packet",
      "Import packet",
      "Clear local draft",
    ]) {
      expect(artifact.html).toContain(label);
    }
    expect(artifact.html).toContain(replanned.sourcePlanHash);
    expect(artifact.html).toContain(replanned.plan.planHash);
    expect(artifact.html).toContain(packet.checksum);
    expect(artifact.html).toContain("This page cannot approve or execute");
    expect(artifact.html).not.toContain("disabled>Copy packet");
    const embedded = artifact.html.match(
      /<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/u,
    )?.[1];
    expect(embedded).toBeDefined();
    if (embedded === undefined) throw new Error("Missing feedback data.");
    const parsed = JSON.parse(embedded) as {
      review: ReviewArtifactInput;
    };
    expect(parsed.review.importedFeedback).toEqual(packet);
  });
});
