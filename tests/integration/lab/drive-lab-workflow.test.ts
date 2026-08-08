import { mkdtempSync, rmSync } from "node:fs";
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
import { DriveLab, DriveLabProviderSelector } from "@dvw/drive-simulator";
import type { EvidenceBuildResult } from "@dvw/evidence-builder";

const temporaryDirectories: string[] = [];
const observedTime = "2026-08-08T13:30:00.000Z";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function workspace(): {
  artifactsRoot: string;
  databasePath: string;
  labRoot: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "dvw-lab-integration-"));
  temporaryDirectories.push(directory);
  return {
    artifactsRoot: join(directory, "artifacts"),
    databasePath: join(directory, "workbench.sqlite"),
    labRoot: join(directory, "lab"),
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

function planningWorkflow(observedNames: string[]): CliPlanningWorkflow {
  return {
    build: ({ policyVersion, scanGeneration, store }) => {
      const indexed = store
        .listActiveItems()
        .find((item) => item.id === "messy-invoice-draft");
      if (indexed === undefined) throw new Error("Missing Drive Lab invoice.");
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
      observedNames.push(target.name);
      const builtEvidence = evidence(target);
      const evidenceId = builtEvidence.bundle.observedFacts[0]?.id;
      if (evidenceId === undefined) throw new Error("Missing lab name fact.");
      return Promise.resolve({
        plan: buildChangePlan({
          candidates: [
            {
              evidence: builtEvidence,
              questions: [],
              reasoning: {
                status: "VALIDATED",
                suggestion: {
                  actionType: "RENAME",
                  confidence: 0.93,
                  desiredState: {
                    name: "2026-08-01 — Hotel Paisano — Invoice.pdf",
                  },
                  evidenceIds: [evidenceId],
                  rationale: "The synthetic invoice matches the naming rule.",
                  reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
                  unresolvedQuestions: [],
                },
              },
            },
          ],
          observedItems: [target],
          policyVersion,
          scanGeneration,
        }),
        questions: [],
      });
    },
  };
}

function runtime(
  paths: ReturnType<typeof workspace>,
  observedNames: string[],
): CliRuntime {
  let generation = 0;
  return {
    artifactsRoot: paths.artifactsRoot,
    databasePath: paths.databasePath,
    defaultProviderId: "lab",
    generationId: () => `scan-lab-${String(++generation)}`,
    now: () => observedTime,
    planning: planningWorkflow(observedNames),
    policyVersion: "1.0.0",
    providers: new DriveLabProviderSelector(paths.labRoot),
  };
}

describe("human-operated Drive Lab workflow", () => {
  test("initializes, scans, replans after edit, applies shared writes, diffs, and resets", async () => {
    const paths = workspace();
    const observedNames: string[] = [];
    const cliRuntime = runtime(paths, observedNames);
    const initialized = await runCli(
      [
        "lab",
        "init",
        "--sandbox",
        paths.labRoot,
        "--scenario",
        "messy-paisano",
        "--json",
      ],
      cliRuntime,
    );
    expect(initialized.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    const initialSnapshot = DriveLab.open(paths.labRoot).snapshot();
    expect(initialized.output).toMatchObject({
      command: "lab",
      data: {
        operation: "init",
        scenario: "messy-paisano",
        snapshotHash: initialSnapshot.hash,
      },
      status: "SUCCESS",
    });
    CliOutputSchema.parse(JSON.parse(initialized.text) as unknown);

    const initialTree = await runCli(
      ["lab", "tree", "--sandbox", paths.labRoot],
      cliRuntime,
    );
    expect(initialTree.text).toContain("Hotel Paisano Invoice draft FINAL.pdf");
    expect(initialTree.text).not.toContain("messy-invoice-draft");

    expect(
      (
        await runCli(
          [
            "scan",
            "--root",
            "messy-root",
            "--provider",
            "lab",
            "--page-size",
            "2",
          ],
          cliRuntime,
        )
      ).exitCode,
    ).toBe(CLI_EXIT_CODES.SUCCESS);
    expect((await runCli(["plan"], cliRuntime)).exitCode).toBe(
      CLI_EXIT_CODES.SUCCESS,
    );

    const edit = await runCli(
      [
        "lab",
        "edit",
        "--sandbox",
        paths.labRoot,
        "--edit-json",
        JSON.stringify({
          itemId: "messy-invoice-draft",
          name: "Operator changed invoice.pdf",
          type: "rename",
        }),
      ],
      cliRuntime,
    );
    expect(edit.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    const changedSnapshot = DriveLab.open(paths.labRoot).snapshot();
    expect(changedSnapshot.hash).not.toBe(initialSnapshot.hash);
    const changedTree = await runCli(
      ["lab", "tree", "--sandbox", paths.labRoot],
      cliRuntime,
    );
    expect({
      changed: changedTree.text,
      initial: initialTree.text,
    }).toMatchSnapshot("initial and changed lab trees");

    await runCli(
      ["scan", "--root", "messy-root", "--provider", "lab"],
      cliRuntime,
    );
    const changedPlan = await runCli(["plan", "--json"], cliRuntime);
    expect(observedNames).toEqual([
      "Hotel Paisano Invoice draft FINAL.pdf",
      "Operator changed invoice.pdf",
    ]);
    expect(changedPlan.output).toMatchSnapshot("planner output after lab edit");

    const diff = await runCli(
      [
        "lab",
        "diff",
        "--sandbox",
        paths.labRoot,
        "--against",
        "baseline",
        "--json",
      ],
      cliRuntime,
    );
    expect(diff.output).toMatchObject({
      command: "lab",
      data: {
        entries: [
          expect.objectContaining({
            itemId: "messy-invoice-draft",
            kind: "CHANGED",
          }),
        ],
        operation: "diff",
      },
    });

    const applyLab = DriveLab.open(paths.labRoot);
    const before = await applyLab.read.getItem("messy-invoice-draft");
    if (!before.ok || before.value === null)
      throw new Error("Missing apply target.");
    const rename = await applyLab.mutation.rename({
      expectedModifiedTime: before.value.modifiedTime,
      name: "2026-08-01 — Hotel Paisano — Invoice.pdf",
      targetId: before.value.id,
    });
    const shortcut = await applyLab.mutation.createShortcut({
      name: "Invoice shortcut",
      parentId: "messy-communications",
      targetId: before.value.id,
    });
    const after = await applyLab.read.getItem(before.value.id);
    const observedShortcut = shortcut.ok
      ? await applyLab.read.getItem(shortcut.value.id)
      : null;
    const receipt = {
      actionCount: 2,
      after: after.ok ? after.value : null,
      renameVerified:
        rename.ok &&
        after.ok &&
        after.value?.name === "2026-08-01 — Hotel Paisano — Invoice.pdf",
      shortcutVerified:
        shortcut.ok &&
        observedShortcut?.ok === true &&
        observedShortcut.value?.shortcutTargetId === before.value.id &&
        observedShortcut.value.parentIds.includes("messy-communications"),
      writeCount: applyLab.writeCount,
    };
    expect(receipt).toMatchObject({
      actionCount: 2,
      renameVerified: true,
      shortcutVerified: true,
      writeCount: 2,
    });
    expect(receipt).toMatchSnapshot("verified shared-provider apply receipt");

    const reset = await runCli(
      ["lab", "reset", "--sandbox", paths.labRoot, "--json"],
      cliRuntime,
    );
    expect(reset.output).toMatchObject({
      command: "lab",
      data: {
        operation: "reset",
        restoredExact: true,
        snapshotHash: initialSnapshot.hash,
      },
    });
    expect(DriveLab.open(paths.labRoot).snapshot()).toEqual(initialSnapshot);
  });

  test("rejects unknown operations and invalid untrusted edit JSON", async () => {
    const paths = workspace();
    const cliRuntime = runtime(paths, []);
    const unknown = await runCli(
      ["lab", "delete", "--sandbox", paths.labRoot],
      cliRuntime,
    );
    expect(unknown.exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
    const initialized = await runCli(
      ["lab", "init", "--sandbox", paths.labRoot, "--scenario", "clean"],
      cliRuntime,
    );
    expect(initialized.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    const invalid = await runCli(
      [
        "lab",
        "edit",
        "--sandbox",
        paths.labRoot,
        "--edit-json",
        '{"type":"delete"}',
      ],
      cliRuntime,
    );
    expect(invalid.exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
    expect(DriveLab.open(paths.labRoot).snapshot()).toEqual(
      DriveLab.open(paths.labRoot).baselineSnapshot(),
    );
  });
});
