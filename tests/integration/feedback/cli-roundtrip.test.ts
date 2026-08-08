import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildReviewFixture } from "../../../apps/review-preview/src/fixture.js";
import {
  CLI_EXIT_CODES,
  CliOutputSchema,
  runCli,
  type CliRuntime,
} from "@dvw/cli";
import {
  createReviewFeedbackPacket,
  feedbackChecksum,
  feedbackContextFromReview,
  serializeReviewFeedbackPacket,
} from "@dvw/feedback";
import type { ReviewArtifactInput } from "@dvw/review-artifact";

function embeddedInput(path: string): ReviewArtifactInput {
  const html = readFileSync(path, "utf8");
  const raw = html.match(
    /<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/u,
  )?.[1];
  if (raw === undefined) throw new Error("Generated HTML has no review data.");
  return (JSON.parse(raw) as { review: ReviewArtifactInput }).review;
}

function runtime(root: string): CliRuntime {
  return {
    artifactsRoot: join(root, "unused-artifacts"),
    databasePath: join(root, "unused.sqlite"),
    defaultProviderId: "unavailable",
    generationId: () => {
      throw new Error("Feedback commands cannot create a scan generation.");
    },
    now: () => "2026-08-08T16:01:00.000Z",
    planning: {
      build: () => {
        throw new Error("Feedback commands cannot call the planning runtime.");
      },
    },
    policyVersion: "1.0.0",
    providers: {
      select: () => {
        throw new Error("Feedback commands cannot select a Drive provider.");
      },
    },
  };
}

describe("HTML to CLI to regenerated HTML", () => {
  test("accepts a pasted packet and preserves every field in a new review", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-feedback-cli-"));
    const built = buildReviewFixture({
      artifactRoot: join(root, "fixture-artifacts"),
      labRoot: join(root, "lab"),
    });
    const inputPath = join(root, "review-input.json");
    writeFileSync(inputPath, `${JSON.stringify(built.input, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const cliRuntime = runtime(root);
    const reviewOutputRoot = join(root, "review-output");
    const review = await runCli(
      ["review", "--input", inputPath, "--output-dir", reviewOutputRoot],
      cliRuntime,
    );
    expect(review.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(review.output).toMatchObject({
      command: "review",
      data: {
        planHash: built.input.plan.planHash,
        reviewRound: 1,
      },
      status: "SUCCESS",
    });
    const originalAction = built.input.plan.actions[0];
    const question = built.input.questions[0];
    if (originalAction === undefined || question === undefined) {
      throw new Error("Fixture is missing review controls.");
    }
    const packet = createReviewFeedbackPacket(
      feedbackContextFromReview(built.input),
      {
        actions: [
          {
            actionId: originalAction.actionId,
            comment: "CLI round-trip action comment.",
            disposition: "Edit",
            proposedName: "2026-08-02 - Hotel Paisano - Paid Invoice.pdf",
            reason: {
              code: "PAID_DATE_CONFIRMED",
              detail: "CLI round-trip structured reason.",
            },
          },
        ],
        globalComment: "CLI round-trip global comment; feedback only.",
        questions: [
          {
            answer: question.choices[0]!,
            comment: "CLI round-trip question comment.",
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
    const feedbackOutputRoot = join(root, "feedback-output");
    const packetText = serializeReviewFeedbackPacket(packet);
    const feedback = await runCli(
      [
        "feedback",
        "import",
        "--input",
        inputPath,
        "--output-dir",
        feedbackOutputRoot,
        "--packet-json",
        `\`\`\`json\n${packetText}\`\`\``,
        "--json",
      ],
      cliRuntime,
    );
    expect(feedback.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    const parsed = CliOutputSchema.parse(feedback.output);
    expect(parsed).toMatchObject({
      command: "feedback",
      data: {
        approvalGranted: false,
        changed: true,
        importedChecksum: packet.checksum,
        nextReviewRound: 2,
        sourcePlanHash: built.input.plan.planHash,
      },
      status: "SUCCESS",
    });
    if (parsed.command !== "feedback") {
      throw new Error("Expected feedback CLI output.");
    }
    expect(parsed.data.nextPlanHash).not.toBe(parsed.data.sourcePlanHash);
    expect(parsed.data.artifactPath).toMatch(
      /review-[a-f0-9]{64}-round-2-[a-f0-9]{64}\.html$/u,
    );
    expect(CliOutputSchema.parse(JSON.parse(feedback.text) as unknown)).toEqual(
      parsed,
    );
    const regenerated = embeddedInput(parsed.data.artifactPath);
    expect(regenerated.importedFeedback).toEqual(packet);
    expect(regenerated.feedbackSummary).toMatchObject({
      importedChecksum: packet.checksum,
      nextPlanHash: parsed.data.nextPlanHash,
      sourcePlanHash: parsed.data.sourcePlanHash,
    });
    expect(regenerated.reviewRound).toBe(2);
    expect(regenerated.plan.planHash).toBe(parsed.data.nextPlanHash);
    expect(readFileSync(inputPath, "utf8")).toBe(
      `${JSON.stringify(built.input, null, 2)}\n`,
    );

    const packetPath = join(root, `feedback-${packet.checksum}.json`);
    writeFileSync(packetPath, packetText, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const fileImport = await runCli(
      [
        "feedback",
        "import",
        "--input",
        inputPath,
        "--output-dir",
        join(root, "feedback-file-output"),
        "--packet",
        packetPath,
      ],
      cliRuntime,
    );
    expect(fileImport.output).toMatchObject({
      command: "feedback",
      data: {
        importedChecksum: packet.checksum,
        nextPlanHash: parsed.data.nextPlanHash,
      },
      status: "SUCCESS",
    });

    for (const [field, mutate] of [
      [
        "planHash",
        (value: typeof packet) => {
          value.planHash = "b".repeat(64);
        },
      ],
      [
        "globalComment",
        (value: typeof packet) => {
          value.globalComment = "<svg onload=alert(1)>";
        },
      ],
    ] as const) {
      const invalid = structuredClone(packet);
      mutate(invalid);
      const payload = Object.fromEntries(
        Object.entries(invalid).filter(([key]) => key !== "checksum"),
      ) as Omit<typeof invalid, "checksum">;
      invalid.checksum = feedbackChecksum(payload);
      const result = await runCli(
        [
          "feedback",
          "import",
          "--input",
          inputPath,
          "--output-dir",
          join(root, `blocked-${field}`),
          "--packet-json",
          JSON.stringify(invalid),
        ],
        cliRuntime,
      );
      expect(result.exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
      expect(result.text).toContain(field);
      expect(result.output).toMatchObject({
        command: "error",
        status: "INVALID_INPUT",
      });
    }
  });
});
