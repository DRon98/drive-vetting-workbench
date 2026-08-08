import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  createQuestionFromPolicy,
  DecisionMemoryStore,
} from "@dvw/decision-memory";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import {
  listMaterialQuestions,
  loadPolicyPack,
  type ValidatedPolicyPack,
} from "@dvw/policy-engine";

const PAISANO_PACK_ROOT = fileURLToPath(
  new URL("../../../packs/paisano", import.meta.url),
);
const temporaryDirectories: string[] = [];
let pack: ValidatedPolicyPack;

beforeAll(async () => {
  pack = await loadPolicyPack(PAISANO_PACK_ROOT);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dvw-decisions-integration-"));
  temporaryDirectories.push(directory);
  return join(directory, "workbench.sqlite");
}

describe("Paisano question and decision round trip", () => {
  test("asks once, isolates scope, invalidates policy, and preserves supersession history", () => {
    const path = databasePath();
    const evidenceStore = new EvidenceStore(path);
    expect(evidenceStore.migrate()).toEqual({
      applied: ["001_evidence", "002_decisions", "003_execution"],
      skipped: [],
    });
    evidenceStore.close();

    const policyQuestion = listMaterialQuestions(pack)[0];
    expect(policyQuestion).toBeDefined();
    if (policyQuestion === undefined) {
      throw new Error("The Paisano communications question is missing.");
    }
    const firstQuestion = createQuestionFromPolicy({
      evidenceIds: ["fact-communications-alpha"],
      policyVersion: pack.version,
      question: policyQuestion,
      relevantEntityIds: [],
    });
    const memory = new DecisionMemoryStore(path);
    const before = memory.resolveQuestion(firstQuestion);
    const firstDecision = memory.saveDecision({
      answer: "---/communications/",
      approver: "buck",
      createdTime: "2026-08-08T14:00:00.000Z",
      evidenceIds: firstQuestion.evidenceIds,
      question: firstQuestion,
    });
    const matchingFixture = createQuestionFromPolicy({
      evidenceIds: ["fact-communications-later"],
      policyVersion: pack.version,
      question: policyQuestion,
      relevantEntityIds: [],
    });
    const reused = memory.resolveQuestion(matchingFixture);
    const changedPolicyQuestion = createQuestionFromPolicy({
      evidenceIds: ["fact-communications-v2"],
      policyVersion: "2.0.0",
      question: {
        ...policyQuestion,
        policyLocators: policyQuestion.policyLocators.map((locator) =>
          locator.replace("paisano:1.0.0/", "paisano:2.0.0/"),
        ),
      },
      relevantEntityIds: [],
    });
    const invalidated = memory.resolveQuestion(changedPolicyQuestion);
    const secondDecision = memory.saveDecision({
      answer: "---/Logged/Communications/",
      approver: "buck",
      createdTime: "2026-08-08T14:05:00.000Z",
      evidenceIds: changedPolicyQuestion.evidenceIds,
      question: changedPolicyQuestion,
      supersedesDecisionId: firstDecision.decisionId,
    });
    const history = memory.listDecisionHistory(firstQuestion.questionKey);
    const active = memory.getActiveDecision(firstQuestion.questionKey);
    memory.close();

    const database = new DatabaseSync(path);
    expect(() =>
      database
        .prepare("UPDATE decisions SET approver = ? WHERE decision_id = ?")
        .run("other", firstDecision.decisionId),
    ).toThrow(/immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM decisions WHERE decision_id = ?")
        .run(firstDecision.decisionId),
    ).toThrow(/immutable/u);
    expect(() =>
      database
        .prepare(
          "UPDATE active_decisions SET decision_id = ? WHERE question_key = ?",
        )
        .run(firstDecision.decisionId, firstQuestion.questionKey),
    ).toThrow(/explicit supersession/u);
    expect(() =>
      database
        .prepare("DELETE FROM active_decisions WHERE question_key = ?")
        .run(firstQuestion.questionKey),
    ).toThrow(/cannot be deleted/u);
    const counts = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM decisions) AS history_count,
           (SELECT COUNT(*) FROM active_decisions) AS active_count`,
      )
      .get();
    database.close();

    expect(firstQuestion.questionKey).toBe(matchingFixture.questionKey);
    expect(firstQuestion.questionKey).toBe(changedPolicyQuestion.questionKey);
    expect(before).toMatchObject({ shouldAsk: true, status: "UNRESOLVED" });
    expect(reused).toMatchObject({
      decision: { decisionId: firstDecision.decisionId },
      shouldAsk: false,
      status: "RESOLVED",
    });
    expect(invalidated).toMatchObject({
      decision: { decisionId: firstDecision.decisionId },
      reason: "POLICY_VERSION_CHANGED",
      shouldAsk: true,
      status: "NEEDS_REVIEW",
    });
    expect(history).toEqual([firstDecision, secondDecision]);
    expect(active).toEqual(secondDecision);
    expect(counts).toEqual({ active_count: 1, history_count: 2 });
    expect({
      active,
      before,
      history,
      invalidated,
      question: firstQuestion,
      reused,
    }).toMatchSnapshot("lossless scoped decision loop");
  });
});
