import { DecisionMemoryStore } from "@dvw/decision-memory";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import type { ParsedCliArguments } from "../io/arguments.js";
import { CliUsageError } from "../io/arguments.js";
import { CliArtifactStore } from "../io/artifacts.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";

export function runQuestionsCommand(
  _args: ParsedCliArguments,
  runtime: CliRuntime,
): CliCommandOutput {
  const store = new EvidenceStore(runtime.databasePath);
  const decisions = new DecisionMemoryStore(runtime.databasePath);
  try {
    store.migrate();
    const coverage = store.getActiveCoverage();
    if (coverage === null)
      throw new CliUsageError("Run scan before questions.");
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
    const questions = artifact.questions.filter(
      (question) => decisions.resolveQuestion(question).shouldAsk,
    );
    return {
      command: "questions",
      data: {
        questionCount: questions.length,
        questions: questions.map((question) => ({
          choices: question.choices,
          prompt: question.prompt,
          questionKey: question.questionKey,
          scope: question.scope,
        })),
      },
      policyVersion: runtime.policyVersion,
      scanGeneration: coverage.generationId,
      status: questions.length > 0 ? "REVIEW_REQUIRED" : "SUCCESS",
    };
  } finally {
    decisions.close();
    store.close();
  }
}
