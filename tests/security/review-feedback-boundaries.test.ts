import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewFixture } from "../../apps/review-preview/src/fixture.js";
import {
  createReviewFeedbackPacket,
  feedbackChecksum,
  feedbackContextFromReview,
  parseReviewFeedbackPacket,
  serializeReviewFeedbackPacket,
} from "@dvw/feedback";
import { generateReviewArtifact } from "@dvw/review-artifact";
import { describe, expect, test } from "vitest";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dvw-security-review-"));
  return buildReviewFixture({
    artifactRoot: join(root, "artifacts"),
    labRoot: join(root, "lab"),
  });
}

function validPacket() {
  const built = fixture();
  const action = built.input.plan.actions[0];
  const question = built.input.questions[0];
  const answer = question?.choices[0];
  if (action === undefined || question === undefined || answer === undefined) {
    throw new Error("The synthetic review fixture is incomplete.");
  }
  const context = feedbackContextFromReview(built.input);
  const packet = createReviewFeedbackPacket(
    context,
    {
      actions: [
        {
          actionId: action.actionId,
          comment: "Synthetic acceptance for the security fixture.",
          disposition: "Accept",
          proposedName: null,
          reason: {
            code: "SECURITY_FIXTURE_ACCEPT",
            detail: "This packet remains feedback only.",
          },
        },
      ],
      globalComment: "Create a new review round. Do not approve or apply.",
      questions: [
        {
          answer,
          comment: "Synthetic answer.",
          questionKey: question.questionKey,
          scope: question.scope,
        },
      ],
    },
    {
      exportedAt: "2026-08-08T16:00:00.000Z",
      reviewer: "Synthetic security reviewer",
    },
  );
  return { built, context, packet };
}

function withChecksum<T extends { readonly checksum: string }>(
  packet: T,
  changes: Record<string, unknown>,
): T {
  const changed = { ...packet, ...changes };
  const payload = Object.fromEntries(
    Object.entries(changed).filter(([key]) => key !== "checksum"),
  );
  return {
    ...changed,
    checksum: feedbackChecksum(payload as never),
  };
}

describe("offline review and feedback trust boundaries", () => {
  test("renders malicious Drive text as inert data under an offline hash-bound CSP", () => {
    const built = fixture();
    const hostile =
      '</script><img src=x onerror=globalThis.pwned=true><a href="https://attacker.invalid">';
    const input = {
      ...built.input,
      nodes: built.input.nodes.map((node, index) =>
        index === 1
          ? {
              ...node,
              evidence: node.evidence.map((entry) => ({
                ...entry,
                value: hostile,
              })),
              name: hostile,
            }
          : node,
      ),
      title: hostile,
    };
    const artifact = generateReviewArtifact(input);

    expect(artifact.html).not.toContain(hostile);
    expect(artifact.html).not.toContain("<img src=x");
    expect(artifact.html).not.toContain("onerror=globalThis");
    expect(artifact.html).not.toContain('href="https://attacker.invalid"');
    expect(artifact.html).toContain("&lt;/script&gt;");
    expect(artifact.html).toContain("\\u003c/script\\u003e");
    expect(artifact.html).toContain("connect-src 'none'");
    expect(artifact.html).toContain("object-src 'none'");
    expect(artifact.html).toContain("form-action 'none'");
    expect(artifact.html).not.toMatch(
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u,
    );
    expect(artifact.html).not.toMatch(/\b(?:approve|apply)\s*\(/iu);
  });

  test("rejects edited, stale, unknown-action, markup, and approval-shaped feedback", () => {
    const { context, packet } = validPacket();
    const serialized = serializeReviewFeedbackPacket(packet);
    const edited = JSON.parse(serialized) as Record<string, unknown>;
    edited.globalComment = "Changed after checksum.";
    expect(() =>
      parseReviewFeedbackPacket(JSON.stringify(edited), context),
    ).toThrow(/checksum/u);

    expect(() =>
      parseReviewFeedbackPacket(serialized, {
        ...context,
        planHash: "f".repeat(64),
        reviewRound: context.reviewRound + 1,
      }),
    ).toThrow(/planHash|reviewRound/u);

    const unknownAction = withChecksum(packet, {
      actions: packet.actions.map((action) => ({
        ...action,
        actionId: "unknown-action",
      })),
    });
    expect(() =>
      parseReviewFeedbackPacket(
        serializeReviewFeedbackPacket(unknownAction),
        context,
      ),
    ).toThrow(/not in this plan|every known action/u);

    const markup = withChecksum(packet, {
      globalComment: "<script>globalThis.pwned=true</script>",
    });
    expect(() =>
      parseReviewFeedbackPacket(JSON.stringify(markup), context),
    ).toThrow(/markup/iu);

    const approvalShaped = withChecksum(packet, { approvalGranted: true });
    expect(() =>
      parseReviewFeedbackPacket(JSON.stringify(approvalShaped), context),
    ).toThrow();
  });
});
