import { isDeepStrictEqual } from "node:util";
import { DecisionMemoryStore } from "@dvw/decision-memory";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import {
  CliUsageError,
  option,
  type ParsedCliArguments,
} from "../io/arguments.js";
import { CliArtifactStore } from "../io/artifacts.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";

function answer(args: ParsedCliArguments): unknown {
  const plain = option(args, "answer");
  if (plain !== undefined) return plain;
  const encoded = option(args, "answer-json");
  if (encoded === undefined) throw new CliUsageError("Decide needs an answer.");
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new CliUsageError("--answer-json must contain one JSON value.");
  }
}

export function runDecideCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): CliCommandOutput {
  const store = new EvidenceStore(runtime.databasePath);
  const decisions = new DecisionMemoryStore(runtime.databasePath);
  try {
    store.migrate();
    const coverage = store.getActiveCoverage();
    if (coverage === null) throw new CliUsageError("Run scan before decide.");
    const artifact = new CliArtifactStore(
      runtime.artifactsRoot,
    ).loadLatestQuestions();
    if (
      artifact.scanGeneration !== coverage.generationId ||
      artifact.policyVersion !== runtime.policyVersion
    ) {
      throw new CliUsageError(
        "Rebuild the plan for the active scan and policy.",
      );
    }
    const questionKey = option(args, "question");
    const approver = option(args, "approver");
    if (questionKey === undefined || approver === undefined) {
      throw new CliUsageError("Decide needs a question and approver.");
    }
    const question = artifact.questions.find(
      (candidate) => candidate.questionKey === questionKey,
    );
    if (question === undefined) {
      throw new CliUsageError(
        "The question is not in the active plan artifact.",
      );
    }
    const active = decisions.getActiveDecision(question.questionKey);
    const answerValue = answer(args);
    const saved =
      active !== null && isDeepStrictEqual(active.answer, answerValue)
        ? active
        : decisions.saveDecision({
            answer: answerValue,
            approver,
            createdTime: runtime.now(),
            evidenceIds: question.evidenceIds,
            question,
            ...(active === null
              ? {}
              : { supersedesDecisionId: active.decisionId }),
          });
    return {
      command: "decide",
      data: {
        decisionId: saved.decisionId,
        provenance: saved.provenance,
        questionKey: saved.questionKey,
        scope: saved.scope,
      },
      policyVersion: runtime.policyVersion,
      scanGeneration: coverage.generationId,
      status: "SUCCESS",
    };
  } finally {
    decisions.close();
    store.close();
  }
}
