import { describe, expect, test } from "vitest";
import {
  FeedbackValidationError,
  ReviewFeedbackPacketSchema,
  createReviewFeedbackPacket,
  parseReviewFeedbackPacket,
  serializeReviewFeedbackPacket,
  type FeedbackReviewContext,
  type ReviewFeedbackDraft,
  type ReviewFeedbackPacket,
} from "./index.js";

const context: FeedbackReviewContext = {
  actions: [
    { actionId: "act_0123456789abcdef0123456789abcdef", type: "RENAME" },
  ],
  artifactVersion: "dvw.review.v1",
  planHash: "a".repeat(64),
  policyVersion: "1.0.0",
  questions: [
    {
      choices: ["Invoice body date", "Observed modified date"],
      questionKey: "question-invoice-date",
      scope: { id: "invoice-1", type: "item" },
    },
  ],
  reviewRound: 1,
  scanGeneration: "scan-fixture-1",
};

const draft: ReviewFeedbackDraft = {
  actions: [
    {
      actionId: context.actions[0]!.actionId,
      comment: "Use the title from the invoice body.",
      disposition: "Edit",
      proposedName: "2026-08-01 - Hotel Paisano - Invoice.pdf",
      reason: {
        code: "DATE_SOURCE_CONFIRMED",
        detail: "Invoice body date is authoritative.",
      },
    },
  ],
  globalComment: "Ready for a new review round, not approval.",
  questions: [
    {
      answer: "Invoice body date",
      comment: "The PDF date is explicit.",
      questionKey: "question-invoice-date",
      scope: { id: "invoice-1", type: "item" },
    },
  ],
};

function packetText(): string {
  return serializeReviewFeedbackPacket(
    createReviewFeedbackPacket(context, draft, {
      exportedAt: "2026-08-08T16:00:00.000Z",
      reviewer: "Buck reviewer",
    }),
  );
}

describe("review feedback packet", () => {
  test("round-trips every supported field with canonical byte stability", () => {
    const serialized = packetText();
    const parsed = parseReviewFeedbackPacket(serialized, context);

    expect(parsed).toMatchObject({
      actions: draft.actions,
      artifactVersion: context.artifactVersion,
      exportedAt: "2026-08-08T16:00:00.000Z",
      globalComment: draft.globalComment,
      packetVersion: "dvw.feedback.v1",
      planHash: context.planHash,
      policyVersion: context.policyVersion,
      questions: draft.questions,
      reviewer: "Buck reviewer",
      reviewRound: context.reviewRound,
      scanGeneration: context.scanGeneration,
    });
    expect(parsed.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(serializeReviewFeedbackPacket(parsed)).toBe(serialized);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(
      parseReviewFeedbackPacket(`\`\`\`json\n${serialized}\`\`\``, context),
    ).toEqual(parsed);
  });

  test.each<[string, (value: ReviewFeedbackPacket) => void, string]>([
    ["checksum", (value) => (value.checksum = "0".repeat(64)), "checksum"],
    ["stale plan", (value) => (value.planHash = "b".repeat(64)), "planHash"],
    [
      "unknown action",
      (value) => {
        const action = value.actions[0];
        if (action !== undefined) action.actionId = "act_unknown";
      },
      "actions.0.actionId",
    ],
    [
      "duplicate answer",
      (value) => {
        const answer = value.questions[0];
        if (answer !== undefined) value.questions.push(answer);
      },
      "questions",
    ],
    [
      "invalid scope",
      (value) => {
        const answer = value.questions[0];
        if (answer !== undefined) answer.scope.id = "other";
      },
      "questions.0.scope",
    ],
    [
      "markup",
      (value) => (value.globalComment = "<img src=x onerror=alert(1)>"),
      "globalComment",
    ],
    [
      "script URL",
      (value) => {
        const action = value.actions[0];
        if (action !== undefined) action.comment = "javascript:alert(1)";
      },
      "actions.0.comment",
    ],
    [
      "invalid edit name",
      (value) => {
        const action = value.actions[0];
        if (action !== undefined) action.proposedName = "../invoice.pdf";
      },
      "actions.0.proposedName",
    ],
  ])("rejects %s with a precise field issue", (_label, mutate, path) => {
    const value = ReviewFeedbackPacketSchema.parse(
      JSON.parse(packetText()) as unknown,
    );
    mutate(value);
    expect(() =>
      parseReviewFeedbackPacket(JSON.stringify(value), context),
    ).toThrow(FeedbackValidationError);
    try {
      parseReviewFeedbackPacket(JSON.stringify(value), context);
    } catch (error) {
      expect(error).toBeInstanceOf(FeedbackValidationError);
      if (error instanceof FeedbackValidationError) {
        expect(error.issues.map((issue) => issue.path).join("\n")).toContain(
          path,
        );
      }
    }
  });

  test("requires complete action and question coverage", () => {
    expect(() =>
      createReviewFeedbackPacket(
        context,
        { actions: [], globalComment: "", questions: [] },
        {
          exportedAt: "2026-08-08T16:00:00.000Z",
          reviewer: "Buck reviewer",
        },
      ),
    ).toThrow(/every known action/u);
  });

  test("rejects executable text nested inside a structured answer during export", () => {
    expect(() =>
      createReviewFeedbackPacket(
        {
          ...context,
          questions: [
            {
              ...context.questions[0]!,
              choices: [{ source: "<svg onload=alert(1)>" }],
            },
          ],
        },
        {
          ...draft,
          questions: [
            {
              ...draft.questions[0]!,
              answer: { source: "<svg onload=alert(1)>" },
            },
          ],
        },
        {
          exportedAt: "2026-08-08T16:00:00.000Z",
          reviewer: "Buck reviewer",
        },
      ),
    ).toThrow(/questions\.0\.answer\.source|Markup/u);
  });
});
