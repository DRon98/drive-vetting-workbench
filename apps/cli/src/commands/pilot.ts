import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PilotPreflightInputSchema,
  PilotRehearsalInputSchema,
  buildPilotScorecard,
  evaluatePilotPreflight,
  serializePilotScorecard,
} from "@dvw/reporting";
import { CliUsageError, option } from "../io/arguments.js";
import type { CliCommandOutput } from "../io/contracts.js";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function readJson(pathValue: string | undefined): unknown {
  if (pathValue === undefined) {
    throw new CliUsageError("Pilot requires --input.");
  }
  try {
    return JSON.parse(readFileSync(resolve(pathValue), "utf8")) as unknown;
  } catch {
    throw new CliUsageError("Pilot input must be one readable JSON file.");
  }
}

function writeScorecardCreateOnly(
  outputDirectory: string | undefined,
  bytes: string,
): { readonly artifactPath: string; readonly artifactSha256: string } {
  if (outputDirectory === undefined) {
    throw new CliUsageError("Pilot scorecard requires --output-dir.");
  }
  const root = resolve(outputDirectory);
  mkdirSync(root, { mode: 0o700, recursive: true });
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactPath = join(root, `pilot-scorecard-${artifactSha256}.json`);
  try {
    writeFileSync(artifactPath, bytes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      errorCode(error) !== "EEXIST" ||
      readFileSync(artifactPath, "utf8") !== bytes
    ) {
      throw new CliUsageError(
        "Pilot scorecard output must be new or byte-identical.",
      );
    }
  }
  return { artifactPath, artifactSha256 };
}

export function runPilotCommand(
  args: Parameters<typeof option>[0],
): CliCommandOutput {
  if (args.pilotOperation === "preflight") {
    let input;
    try {
      input = PilotPreflightInputSchema.parse(readJson(option(args, "input")));
    } catch (error) {
      if (error instanceof CliUsageError) throw error;
      throw new CliUsageError("Pilot preflight input is invalid.");
    }
    const result = evaluatePilotPreflight(input);
    return {
      command: "pilot",
      data: { operation: "preflight", result },
      policyVersion: input.policyVersion,
      scanGeneration: null,
      status: result.status === "READY" ? "SUCCESS" : "REVIEW_REQUIRED",
    };
  }

  let input;
  try {
    input = PilotRehearsalInputSchema.parse(readJson(option(args, "input")));
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Pilot scorecard input is invalid.");
  }
  const scorecard = buildPilotScorecard(input);
  const written = writeScorecardCreateOnly(
    option(args, "output-dir"),
    serializePilotScorecard(scorecard),
  );
  return {
    command: "pilot",
    data: {
      ...written,
      feedbackPacketPath: scorecard.artifacts.feedbackPacketPath,
      operation: "scorecard",
      reviewArtifactPath: scorecard.artifacts.reviewArtifactPath,
      scorecard,
    },
    policyVersion: scorecard.policyVersion,
    scanGeneration: scorecard.scanGeneration,
    status: scorecard.expansion.allowed ? "SUCCESS" : "REVIEW_REQUIRED",
  };
}
