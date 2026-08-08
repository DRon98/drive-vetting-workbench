import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ReviewArtifactInputSchema,
  generateReviewArtifact,
  writeReviewArtifactCreateOnly,
  type ReviewArtifactInput,
} from "@dvw/review-artifact";
import { z } from "zod";
import {
  CliUsageError,
  option,
  type ParsedCliArguments,
} from "../io/arguments.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";

const MAX_REVIEW_INPUT_BYTES = 10 * 1024 * 1024;

function required(args: ParsedCliArguments, name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new CliUsageError(`--${name} is required.`);
  return value;
}

function readBounded(
  path: string,
  maximumBytes: number,
  label: string,
): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new CliUsageError(`${label} cannot be read: ${path}`);
  }
  if (size > maximumBytes) {
    throw new CliUsageError(`${label} exceeds ${maximumBytes} bytes.`);
  }
  return readFileSync(path, "utf8");
}

export function loadReviewInput(path: string): ReviewArtifactInput {
  const text = readBounded(path, MAX_REVIEW_INPUT_BYTES, "Review input");
  try {
    return ReviewArtifactInputSchema.parse(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      throw new CliUsageError(
        `Review input ${first?.path.join(".") || "packet"}: ${first?.message ?? "is invalid"}.`,
      );
    }
    throw new CliUsageError("Review input must be one valid JSON object.");
  }
}

export function writeContentAddressedReview(
  input: ReviewArtifactInput,
  outputDirectory: string,
) {
  const generated = generateReviewArtifact(input);
  const artifactPath = resolve(
    join(
      outputDirectory,
      `review-${input.plan.planHash}-round-${input.reviewRound}-${generated.htmlSha256}.html`,
    ),
  );
  const artifact = writeReviewArtifactCreateOnly(artifactPath, input);
  return { artifact, artifactPath };
}

export async function runReviewCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  void runtime;
  await Promise.resolve();
  const input = loadReviewInput(required(args, "input"));
  const written = writeContentAddressedReview(
    input,
    required(args, "output-dir"),
  );
  return {
    command: "review",
    data: {
      artifactPath: written.artifactPath,
      artifactSha256: written.artifact.htmlSha256,
      planHash: input.plan.planHash,
      reviewRound: input.reviewRound,
    },
    policyVersion: input.plan.policyVersion,
    scanGeneration: input.plan.scanGeneration,
    status: "SUCCESS",
  };
}

export function readFeedbackPacketFile(path: string): string {
  return readBounded(path, 1024 * 1024, "Feedback packet");
}
