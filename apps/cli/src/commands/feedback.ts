import {
  FeedbackValidationError,
  feedbackContextFromReview,
  parseReviewFeedbackPacket,
  replanFromReviewFeedback,
} from "@dvw/feedback";
import { ReviewArtifactInputSchema } from "@dvw/review-artifact";
import {
  CliUsageError,
  option,
  type ParsedCliArguments,
} from "../io/arguments.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";
import {
  loadReviewInput,
  readFeedbackPacketFile,
  writeContentAddressedReview,
} from "./review.js";

function required(args: ParsedCliArguments, name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new CliUsageError(`--${name} is required.`);
  return value;
}

function packetText(args: ParsedCliArguments): string {
  const inline = option(args, "packet-json");
  if (inline !== undefined) return inline;
  return readFeedbackPacketFile(required(args, "packet"));
}

export async function runFeedbackCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  await Promise.resolve();
  if (args.feedbackOperation !== "import") {
    throw new CliUsageError("Feedback requires the import operation.");
  }
  const source = loadReviewInput(required(args, "input"));
  let packet;
  try {
    packet = parseReviewFeedbackPacket(
      packetText(args),
      feedbackContextFromReview(source),
    );
  } catch (error) {
    if (error instanceof FeedbackValidationError) {
      throw new CliUsageError(`Feedback import blocked. ${error.message}`);
    }
    throw error;
  }
  const replanned = replanFromReviewFeedback(source, packet);
  const regenerated = ReviewArtifactInputSchema.parse({
    ...source,
    feedbackSummary: {
      importedChecksum: packet.checksum,
      nextPlanHash: replanned.plan.planHash,
      nextReviewRound: replanned.reviewRound,
      sourcePlanHash: replanned.sourcePlanHash,
      sourceReviewRound: source.reviewRound,
    },
    generatedAt: runtime.now(),
    importedFeedback: packet,
    nextHumanAction:
      "Review the feedback-driven proposal. A separate approval artifact is still required before any write.",
    plan: replanned.plan,
    reviewRound: replanned.reviewRound,
    sources: [
      ...source.sources,
      {
        claim:
          "A checksummed review packet requested this deterministic replan without granting approval.",
        label: "Imported review feedback",
        locator: `feedback:sha256:${packet.checksum}`,
      },
    ],
  });
  const written = writeContentAddressedReview(
    regenerated,
    required(args, "output-dir"),
  );
  return {
    command: "feedback",
    data: {
      approvalGranted: false,
      artifactPath: written.artifactPath,
      artifactSha256: written.artifact.htmlSha256,
      changed: replanned.plan.planHash !== source.plan.planHash,
      importedChecksum: packet.checksum,
      nextPlanHash: replanned.plan.planHash,
      nextReviewRound: replanned.reviewRound,
      sourcePlanHash: replanned.sourcePlanHash,
      sourceReviewRound: source.reviewRound,
    },
    policyVersion: regenerated.plan.policyVersion,
    scanGeneration: regenerated.plan.scanGeneration,
    status: "SUCCESS",
  };
}
