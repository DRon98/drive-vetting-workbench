import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CLI_EXIT_CODES,
  CliOutputSchema,
  runCli,
  type CliPlanningWorkflow,
  type CliRuntime,
} from "@dvw/cli";
import { buildChangePlan } from "@dvw/change-planner";
import type { ObservedItem } from "@dvw/core";
import { createQuestion } from "@dvw/decision-memory";
import {
  createInstrumentedFakeDrive,
  type FakeDriveFixture,
} from "@dvw/drive-provider";
import type { EvidenceBuildResult } from "@dvw/evidence-builder";

const temporaryDirectories: string[] = [];
const observedTime = "2026-08-08T13:00:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function workspace(): { artifactsRoot: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "dvw-cli-read-"));
  temporaryDirectories.push(directory);
  return {
    artifactsRoot: join(directory, "artifacts"),
    databasePath: join(directory, "workbench.sqlite"),
  };
}

function fixture(denied = false): FakeDriveFixture {
  const base = (input: {
    id: string;
    name: string;
    permissions?: ObservedItem["permissions"];
  }): ObservedItem => ({
    contentFingerprint: null,
    createdTime: observedTime,
    id: input.id,
    mimeType: "application/pdf",
    modifiedTime: observedTime,
    name: input.name,
    parentIds: ["fixture-root"],
    permissions: input.permissions ?? { canRead: true, canWrite: true },
    scanGeneration: "provider-fixture",
    shortcutTargetId: null,
    trashed: false,
  });
  return {
    items: [
      {
        item: base({
          id: "invoice-private-id",
          name: "Hotel Paisano Invoice draft.pdf",
        }),
        nativeExports: [
          {
            mimeType: "text/plain",
            text: "Synthetic secret body that must never be printed.",
          },
        ],
      },
      {
        item: base({
          id: "memo-private-id",
          name: "Board Memo.pdf",
          ...(denied
            ? {
                permissions: {
                  canRead: false,
                  canWrite: false,
                  deniedReason: "Synthetic denial",
                },
              }
            : {}),
        }),
        ...(denied ? { readDenied: true } : {}),
      },
    ],
    rootIds: ["fixture-root"],
  };
}

function evidence(target: ObservedItem): EvidenceBuildResult {
  const evidenceId = `fact-${target.id}-name`;
  return {
    bundle: {
      candidateDocumentTypes: [{ confidence: 0.96, documentTypeId: "invoice" }],
      candidateEntities: [{ confidence: 0.97, entityId: "hotel-paisano" }],
      conflicts: [],
      matchedRules: [
        {
          policyLocator: "paisano:1.0.0/naming.json#invoice",
          reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
        },
      ],
      observedFacts: [
        {
          field: "item.name",
          id: evidenceId,
          source: "Observed",
          sourceLocator: `drive:item:${target.id}#name`,
          value: target.name,
        },
      ],
      sourceLocators: [
        `drive:item:${target.id}#name`,
        "paisano:1.0.0/naming.json#invoice",
      ],
      targetId: target.id,
    },
    context: {
      archive: {
        actionType: "KEEP",
        identityComponents: [],
        isArchive: false,
        isConfigured: false,
        isFrozen: false,
        itemId: target.id,
        matchedRules: [],
        preserveHierarchy: false,
        reasonCode: "PAISANO.ARCHIVE.NOT_AN_ARCHIVE",
      },
      protected: {
        actionType: "KEEP",
        flags: [],
        itemId: target.id,
        matchedRules: [],
        reasonCode: "PAISANO.PROTECTED.NO_RULE_MATCH",
      },
    },
    duplicateCandidates: [],
    namingParts: [],
    policyVersion: "1.0.0",
    reviewState: "DETERMINISTIC",
    scanGeneration: target.scanGeneration,
  };
}

function planningWorkflow(): CliPlanningWorkflow {
  return {
    build: ({ decisions, policyVersion, scanGeneration, store }) => {
      const indexed = store
        .listActiveItems()
        .find((item) => item.id === "invoice-private-id");
      if (indexed === undefined) throw new Error("Missing invoice fixture.");
      const target: ObservedItem = {
        contentFingerprint: indexed.contentFingerprint,
        createdTime: indexed.createdTime,
        id: indexed.id,
        mimeType: indexed.mimeType,
        modifiedTime: indexed.modifiedTime,
        name: indexed.name,
        parentIds: indexed.parentIds,
        permissions: indexed.permissions,
        scanGeneration: indexed.scanGeneration,
        shortcutTargetId: indexed.shortcutTargetId,
        trashed: indexed.trashed,
      };
      const builtEvidence = evidence(target);
      const evidenceId = builtEvidence.bundle.observedFacts[0]?.id;
      if (evidenceId === undefined) throw new Error("Missing fixture fact.");
      const question = createQuestion({
        choices: ["invoice-date", "modified-date"],
        evidenceIds: [evidenceId],
        issueType: "INVOICE_DATE_SOURCE",
        policyLocators: ["paisano:1.0.0/naming.json#invoice"],
        policyVersion,
        prompt: "Which date should the invoice name use?",
        relevantEntityIds: ["hotel-paisano"],
        scope: { id: target.id, type: "item" },
      });
      const resolution = decisions.resolveQuestion(question);
      const plan = buildChangePlan({
        candidates: [
          {
            evidence: builtEvidence,
            questions: [{ questionKey: question.questionKey, resolution }],
            reasoning: {
              status: "VALIDATED",
              suggestion: {
                actionType: "RENAME",
                confidence: 0.93,
                desiredState: {
                  name: "2026-08-01 — Hotel Paisano — Invoice.pdf",
                },
                evidenceIds: [evidenceId],
                rationale: "The scoped answer selects the naming date source.",
                reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
                unresolvedQuestions: [
                  {
                    evidenceIds: [evidenceId],
                    prompt: question.prompt,
                    questionKey: question.questionKey,
                  },
                ],
              },
            },
          },
        ],
        observedItems: [target],
        policyVersion,
        scanGeneration,
      });
      return Promise.resolve({ plan, questions: [question] });
    },
  };
}

function runtime(
  input: {
    denied?: boolean;
    selectorFailure?: boolean;
  } = {},
) {
  const paths = workspace();
  const drive = createInstrumentedFakeDrive(fixture(input.denied));
  let selections = 0;
  const value: CliRuntime = {
    ...paths,
    defaultProviderId: "fixture",
    generationId: () => "scan-cli-1",
    now: () => observedTime,
    planning: planningWorkflow(),
    policyVersion: "1.0.0",
    providers: {
      select: ({ providerId }) => {
        selections += 1;
        if (input.selectorFailure) throw new Error("secret selector failure");
        expect(providerId).toBe("fixture");
        return Promise.resolve({ providerId, read: drive.read });
      },
    },
  };
  return { drive, runtime: value, selections: () => selections };
}

describe("fixture-backed read and planning CLI", () => {
  test("scans, inventories, asks, decides, and rebuilds in human and JSON modes", async () => {
    const harness = runtime();
    const scan = await runCli(
      ["scan", "--root", "fixture-root", "--provider", "fixture"],
      harness.runtime,
    );
    const inventory = await runCli(
      ["inventory", "--query", "Invoice", "--json"],
      harness.runtime,
    );
    const firstPlan = await runCli(["plan"], harness.runtime);
    const questions = await runCli(["questions", "--json"], harness.runtime);
    const parsedQuestions = CliOutputSchema.parse(questions.output);
    if (parsedQuestions.command !== "questions") {
      throw new Error("Expected question output.");
    }
    const question = parsedQuestions.data.questions[0];
    expect(question).toBeDefined();
    if (question === undefined) throw new Error("Missing CLI question.");
    const decide = await runCli(
      [
        "decide",
        "--question",
        question.questionKey,
        "--answer",
        "invoice-date",
        "--approver",
        "buck",
      ],
      harness.runtime,
    );
    const secondPlan = await runCli(["plan", "--json"], harness.runtime);
    const outputs = [scan, inventory, firstPlan, questions, decide, secondPlan];

    for (const result of outputs) CliOutputSchema.parse(result.output);
    CliOutputSchema.parse(JSON.parse(inventory.text) as unknown);
    CliOutputSchema.parse(JSON.parse(secondPlan.text) as unknown);
    expect(outputs.map((result) => result.exitCode)).toEqual([
      CLI_EXIT_CODES.SUCCESS,
      CLI_EXIT_CODES.SUCCESS,
      CLI_EXIT_CODES.REVIEW_REQUIRED,
      CLI_EXIT_CODES.REVIEW_REQUIRED,
      CLI_EXIT_CODES.SUCCESS,
      CLI_EXIT_CODES.SUCCESS,
    ]);
    const parsedInventory = CliOutputSchema.parse(inventory.output);
    expect(parsedInventory).toMatchObject({
      command: "inventory",
      data: {
        items: [expect.objectContaining({ id: "invoice-private-id" })],
      },
      policyVersion: "1.0.0",
      scanGeneration: "scan-cli-1",
    });
    const parsedPlan = CliOutputSchema.parse(secondPlan.output);
    expect(parsedPlan).toMatchObject({
      command: "plan",
      data: {
        actions: [
          expect.objectContaining({
            targetId: "invoice-private-id",
            type: "RENAME",
          }),
        ],
        approvalEligible: true,
        questionCount: 0,
      },
      status: "SUCCESS",
    });
    const transcript = [scan.text, firstPlan.text, decide.text].join("\n");
    expect(transcript).not.toContain("invoice-private-id");
    expect(transcript).not.toContain("Synthetic secret body");
    expect(JSON.stringify(outputs)).not.toContain("Synthetic secret body");
    expect(harness.drive.writeCount).toBe(0);
    expect(harness.drive.mutationRequests).toEqual([]);
    expect(harness.selections()).toBe(1);
    expect(
      outputs.every(
        (result) =>
          result.output.command !== "error" &&
          result.output.policyVersion === "1.0.0" &&
          result.output.scanGeneration === "scan-cli-1",
      ),
    ).toBe(true);
    const artifactFiles = readdirSync(harness.runtime.artifactsRoot).sort();
    expect(
      artifactFiles.filter((file) => file.startsWith("plan-")),
    ).toHaveLength(2);
    expect(
      artifactFiles.filter((file) => file.startsWith("questions-")),
    ).toHaveLength(1);
    expect(
      readFileSync(
        join(harness.runtime.artifactsRoot, "artifact-ledger.ndjson"),
        "utf8",
      )
        .trim()
        .split("\n"),
    ).toHaveLength(4);
    expect(transcript).toMatchSnapshot("concise human CLI transcript");
    expect({
      inventory: inventory.output,
      plan: secondPlan.output,
    }).toMatchSnapshot("stable JSON CLI output");
  });

  test("requires an explicit scan root and reports a coverage-gap exit", async () => {
    expect(new Set(Object.values(CLI_EXIT_CODES)).size).toBe(5);
    const invalidHarness = runtime();
    const invalid = await runCli(["scan"], invalidHarness.runtime);
    expect(invalid.exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
    expect(invalidHarness.selections()).toBe(0);

    const gapHarness = runtime({ denied: true });
    const gap = await runCli(
      ["scan", "--root", "fixture-root"],
      gapHarness.runtime,
    );
    expect(gap.exitCode).toBe(CLI_EXIT_CODES.COVERAGE_GAP);
    expect(gap.output).toMatchObject({
      command: "scan",
      data: { deniedItemCount: 1, issueCount: 1 },
      status: "COVERAGE_GAP",
    });
    expect(gapHarness.drive.writeCount).toBe(0);
  });

  test("redacts internal failures", async () => {
    const harness = runtime({ selectorFailure: true });
    const result = await runCli(
      ["scan", "--root", "fixture-root"],
      harness.runtime,
    );
    expect(result.exitCode).toBe(CLI_EXIT_CODES.INTERNAL_FAILURE);
    expect(result.text).not.toContain("secret selector failure");
    expect(JSON.stringify(result.output)).not.toContain(
      "secret selector failure",
    );
  });
});
