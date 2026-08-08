import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildReviewFixture } from "../../../apps/review-preview/src/fixture.js";
import {
  createReviewFeedbackPacket,
  feedbackContextFromReview,
  replanFromReviewFeedback,
  serializeReviewFeedbackPacket,
} from "@dvw/feedback";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dvw-feedback-integration-"));
  return buildReviewFixture({
    artifactRoot: join(root, "artifacts"),
    labRoot: join(root, "lab"),
  });
}

describe("feedback to deterministic replan", () => {
  test("preserves rich feedback, changes the plan identity, and grants no approval", () => {
    const built = fixture();
    const original = built.input;
    const originalAction = original.plan.actions[0];
    const question = original.questions[0];
    expect(originalAction).toBeDefined();
    expect(question).toBeDefined();
    if (originalAction === undefined || question === undefined) {
      throw new Error("Review fixture is incomplete.");
    }
    const context = feedbackContextFromReview(original);
    const packet = createReviewFeedbackPacket(
      context,
      {
        actions: [
          {
            actionId: originalAction.actionId,
            comment: "Keep the source; change only this proposed name.",
            disposition: "Edit",
            proposedName: "2026-08-02 - Hotel Paisano - Paid Invoice.pdf",
            reason: {
              code: "PAID_DATE_CONFIRMED",
              detail: "The paid stamp is the controlling date.",
            },
          },
        ],
        globalComment: "Return a new review round; this is not approval.",
        questions: [
          {
            answer: "Invoice body date",
            comment: "Use the date printed in the body.",
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

    const first = replanFromReviewFeedback(original, packet);
    const second = replanFromReviewFeedback(original, packet);

    expect(second).toEqual(first);
    expect(first.approvalGranted).toBe(false);
    expect(first.sourcePlanHash).toBe(original.plan.planHash);
    expect(first.plan.planHash).not.toBe(original.plan.planHash);
    expect(first.reviewRound).toBe(2);
    expect(first.plan.actions).toHaveLength(1);
    expect(first.plan.actions[0]).toMatchObject({
      desiredState: {
        name: "2026-08-02 - Hotel Paisano - Paid Invoice.pdf",
      },
      reasonCode: "HUMAN_FEEDBACK.PAID_DATE_CONFIRMED",
      reviewState: "Blocked",
      type: "RENAME",
    });
    expect(first.plan.approvalEligible).toBe(false);
    expect(first.plan.effectiveActions).toEqual([]);
    expect(first.plan.blockers).toEqual([
      expect.objectContaining({
        actionIds: [first.plan.actions[0]?.actionId],
        code: "NEEDS_REVIEW_ACTION",
      }),
    ]);
    expect(first.plan.actions[0]?.actionId).not.toBe(originalAction.actionId);
    expect(first.decisionCandidates).toEqual([
      {
        answer: "Invoice body date",
        comment: "Use the date printed in the body.",
        packetChecksum: packet.checksum,
        policyVersion: original.plan.policyVersion,
        questionKey: question.questionKey,
        reviewer: "Buck reviewer",
        scope: question.scope,
      },
    ]);
    expect(first.plannerInputs).toEqual([
      expect.objectContaining({
        disposition: "Edit",
        sourceActionId: originalAction.actionId,
      }),
    ]);
    expect(first.preview.acceptedFields).toContain("actions.0.proposedName");
    expect(first.preview.ignoredFields).toEqual([]);
    expect(first.preview.rejectedFields).toEqual([]);
    expect(serializeReviewFeedbackPacket(packet)).toContain(
      "Return a new review round; this is not approval.",
    );
  });

  test.each([
    ["Accept", false, "RENAME", 1],
    ["Reject", true, undefined, 0],
    ["Ask", true, "NEEDS_REVIEW", 1],
  ] as const)(
    "%s remains feedback-only and has a deterministic safe plan effect",
    (disposition, changesPlan, expectedType, actionCount) => {
      const built = fixture();
      const action = built.input.plan.actions[0];
      const question = built.input.questions[0];
      if (action === undefined || question === undefined) {
        throw new Error("Review fixture is incomplete.");
      }
      const packet = createReviewFeedbackPacket(
        feedbackContextFromReview(built.input),
        {
          actions: [
            {
              actionId: action.actionId,
              comment: `${disposition} is review feedback only.`,
              disposition,
              proposedName: null,
              reason: {
                code: `REVIEW_${disposition.toUpperCase()}`,
                detail: "Exercise the disposition contract.",
              },
            },
          ],
          globalComment: "No approval is granted.",
          questions: [
            {
              answer: question.choices[0]!,
              comment: "Keep the scoped answer.",
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
      const result = replanFromReviewFeedback(built.input, packet);
      expect(result.approvalGranted).toBe(false);
      expect(result.plan.actions).toHaveLength(actionCount);
      expect(result.plan.actions[0]?.type).toBe(expectedType);
      expect(result.plan.planHash === built.input.plan.planHash).toBe(
        !changesPlan,
      );
      expect(result.reviewRound).toBe(changesPlan ? 2 : 1);
      if (disposition === "Ask") {
        expect(result.plan.approvalEligible).toBe(false);
        expect(result.plan.blockers[0]?.code).toBe("NEEDS_REVIEW_ACTION");
      }
    },
  );
});
