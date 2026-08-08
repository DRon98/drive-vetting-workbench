import { DecisionMemoryStore } from "@dvw/decision-memory";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import type { ParsedCliArguments } from "../io/arguments.js";
import { CliUsageError } from "../io/arguments.js";
import { CliArtifactStore } from "../io/artifacts.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";

export async function runPlanCommand(
  _args: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  const store = new EvidenceStore(runtime.databasePath);
  const decisions = new DecisionMemoryStore(runtime.databasePath);
  try {
    store.migrate();
    const coverage = store.getActiveCoverage();
    if (coverage === null) throw new CliUsageError("Run scan before plan.");
    const built = await runtime.planning.build({
      decisions,
      policyVersion: runtime.policyVersion,
      scanGeneration: coverage.generationId,
      store,
    });
    if (
      built.plan.policyVersion !== runtime.policyVersion ||
      built.plan.scanGeneration !== coverage.generationId
    ) {
      throw new Error("Planning workflow returned a stale plan context.");
    }
    const unresolvedQuestions = built.questions.filter(
      (question) => decisions.resolveQuestion(question).shouldAsk,
    );
    const artifacts = new CliArtifactStore(runtime.artifactsRoot);
    artifacts.saveQuestions(
      {
        policyVersion: runtime.policyVersion,
        questions: built.questions,
        scanGeneration: coverage.generationId,
      },
      runtime.now(),
    );
    artifacts.savePlan(built.plan, runtime.now());
    const reviewRequired =
      !built.plan.approvalEligible || unresolvedQuestions.length > 0;
    return {
      command: "plan",
      data: {
        actionCount: built.plan.actions.length,
        actions: built.plan.actions.map((action) => ({
          actionId: action.actionId,
          reviewState: action.reviewState,
          targetId: action.targetId,
          type: action.type,
        })),
        approvalEligible: built.plan.approvalEligible,
        blockers: built.plan.blockers.map((blocker) => ({
          actionIds: blocker.actionIds,
          code: blocker.code,
          targetIds: blocker.targetIds,
        })),
        effectiveActionCount: built.plan.effectiveActions.length,
        planHash: built.plan.planHash,
        questionCount: unresolvedQuestions.length,
      },
      policyVersion: runtime.policyVersion,
      scanGeneration: coverage.generationId,
      status: reviewRequired ? "REVIEW_REQUIRED" : "SUCCESS",
    };
  } finally {
    decisions.close();
    store.close();
  }
}
