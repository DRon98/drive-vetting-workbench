import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewFixture } from "../../apps/review-preview/src/fixture.js";
import {
  CLI_EXIT_CODES,
  CliOutputSchema,
  runCli,
  type CliRuntime,
} from "@dvw/cli";
import { DriveLab } from "@dvw/drive-simulator";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import {
  applyApprovedPlan,
  createApprovalArtifact,
  dryRunApprovedPlan,
  ExecutionLedger,
  verifyRecordedRun,
} from "@dvw/execution";
import {
  createReviewFeedbackPacket,
  feedbackContextFromReview,
  parseReviewFeedbackPacket,
  replanFromReviewFeedback,
  serializeReviewFeedbackPacket,
} from "@dvw/feedback";
import {
  PILOT_GATE_IDS,
  PilotRehearsalInputSchema,
  PilotScorecardSchema,
  type PilotRehearsalInput,
} from "@dvw/reporting";
import { writeReviewArtifactCreateOnly } from "@dvw/review-artifact";
import { scanFolder } from "@dvw/scanner";
import { afterEach, describe, expect, test, vi } from "vitest";

const checkedAt = "2026-08-08T18:30:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

function createLedger(root: string): ExecutionLedger {
  const databasePath = join(root, "execution.sqlite");
  const store = new EvidenceStore(databasePath);
  store.migrate();
  store.close();
  return new ExecutionLedger(databasePath);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function pilotRuntime(root: string): {
  readonly providerSelections: () => number;
  readonly runtime: CliRuntime;
} {
  let selections = 0;
  return {
    providerSelections: () => selections,
    runtime: {
      artifactsRoot: join(root, "cli-artifacts"),
      databasePath: join(root, "cli.sqlite"),
      defaultProviderId: "forbidden-in-pilot-rehearsal",
      generationId: () => "forbidden-generation",
      now: () => checkedAt,
      planning: {
        build: () =>
          Promise.reject(
            new Error("Pilot rehearsal must not invoke the planner."),
          ),
      },
      policyVersion: "paisano:1.0.0",
      providers: {
        select: () => {
          selections += 1;
          return Promise.reject(
            new Error("Pilot rehearsal must not access a provider."),
          );
        },
      },
    },
  };
}

describe("one-folder pilot rehearsal", () => {
  test("completes the Drive Lab and offline feedback loop, then writes a filled scorecard", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-pilot-rehearsal-"));
    const labRoot = join(root, "drive-lab");
    const lab = DriveLab.initialize(labRoot, "messy-paisano");
    lab.applyEdit({
      content: "Synthetic operator edit for the pilot rehearsal.",
      exportMimeType: "text/plain",
      itemId: "messy-invoice-draft",
      type: "content",
    });

    const evidenceStore = new EvidenceStore(join(root, "evidence.sqlite"));
    evidenceStore.migrate();
    const scan = await scanFolder({
      extractContent: false,
      generationId: "scan-pilot-synthetic-1",
      maxShortcutDepth: 8,
      pageSize: 2,
      provider: lab.read,
      rootId: lab.manifest.rootId,
      startedAt: "2026-08-08T18:00:00.000Z",
      store: evidenceStore,
    });
    evidenceStore.close();
    expect(scan).toMatchObject({ itemCount: 4, pageCount: 2, published: true });

    const firstReview = buildReviewFixture({
      artifactRoot: join(root, "review-round-1"),
      labRoot,
    });
    const sourceAction = firstReview.input.plan.actions[0];
    const sourceQuestion = firstReview.input.questions[0];
    const answer = sourceQuestion?.choices[0];
    if (
      sourceAction === undefined ||
      sourceQuestion === undefined ||
      answer === undefined
    ) {
      throw new Error("The synthetic review inputs are incomplete.");
    }
    const packet = createReviewFeedbackPacket(
      feedbackContextFromReview(firstReview.input),
      {
        actions: [
          {
            actionId: sourceAction.actionId,
            comment: "Accept the policy-backed synthetic rename.",
            disposition: "Accept",
            proposedName: null,
            reason: {
              code: "REVIEWER_ACCEPT",
              detail: "The synthetic operator accepted the proposal unchanged.",
            },
          },
        ],
        globalComment: "Continue to a separate approval gate.",
        questions: [
          {
            answer,
            comment: "Use the synthetic invoice body date.",
            questionKey: sourceQuestion.questionKey,
            scope: sourceQuestion.scope,
          },
        ],
      },
      {
        exportedAt: "2026-08-08T18:10:00.000Z",
        reviewer: "Synthetic pilot operator",
      },
    );
    const serializedPacket = serializeReviewFeedbackPacket(packet);
    const packetPath = join(root, "feedback-round-1.json");
    writeFileSync(packetPath, serializedPacket, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const importedPacket = parseReviewFeedbackPacket(
      `\`\`\`json\n${serializedPacket.trimEnd()}\n\`\`\``,
      feedbackContextFromReview(firstReview.input),
    );
    expect(serializeReviewFeedbackPacket(importedPacket)).toBe(
      serializedPacket,
    );

    const replanned = replanFromReviewFeedback(
      firstReview.input,
      importedPacket,
    );
    expect(replanned.approvalGranted).toBe(false);
    expect(replanned.reviewRound).toBe(firstReview.input.reviewRound);
    expect(replanned.plan.planHash).toBe(firstReview.input.plan.planHash);
    expect(replanned.plan.approvalEligible).toBe(true);
    const secondReviewRound = firstReview.input.reviewRound + 1;

    let networkRequests = 0;
    vi.stubGlobal("fetch", () => {
      networkRequests += 1;
      return Promise.reject(
        new Error("The offline pilot review attempted a network request."),
      );
    });
    const secondReviewPath = join(
      root,
      "review-round-2",
      `review-${replanned.plan.planHash}.html`,
    );
    const secondReview = writeReviewArtifactCreateOnly(secondReviewPath, {
      ...firstReview.input,
      feedbackSummary: {
        importedChecksum: importedPacket.checksum,
        nextPlanHash: replanned.plan.planHash,
        nextReviewRound: secondReviewRound,
        sourcePlanHash: firstReview.input.plan.planHash,
        sourceReviewRound: firstReview.input.reviewRound,
      },
      generatedAt: "2026-08-08T18:15:00.000Z",
      importedFeedback: importedPacket,
      nextHumanAction: "Approve the exact plan through the separate gate.",
      plan: replanned.plan,
      questions: [],
      reviewRound: secondReviewRound,
      title: "Synthetic one-folder pilot review",
    });
    expect(secondReview.html).toContain(importedPacket.checksum);
    expect(secondReview.html).toContain("connect-src 'none'");
    expect(networkRequests).toBe(0);

    const approval = createApprovalArtifact(replanned.plan, {
      approvedAt: "2026-08-08T18:20:00.000Z",
      approver: "Synthetic pilot operator",
      confirmation: `APPROVE ${replanned.plan.planHash}`,
      expiresAt: "2026-08-08T19:20:00.000Z",
    });
    const dryRun = await dryRunApprovedPlan({
      approval,
      checkedAt,
      plan: replanned.plan,
      provider: lab.read,
    });
    expect(dryRun).toMatchObject({ status: "Ready", writeCount: 0 });
    expect(lab.writeCount).toBe(0);

    const ledger = createLedger(root);
    const applied = await applyApprovedPlan({
      approval,
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T18:31:00.000Z",
      plan: replanned.plan,
      providerId: "drive-lab",
      readProvider: lab.read,
    });
    const verified = await verifyRecordedRun({
      ledger,
      plan: replanned.plan,
      readProvider: lab.read,
      runId: applied.runId,
    });
    const writeCountBeforeReplay = lab.writeCount;
    const replay = await applyApprovedPlan({
      approval,
      checkedAt,
      ledger,
      mutationProvider: lab.mutation,
      now: () => "2026-08-08T18:32:00.000Z",
      plan: replanned.plan,
      providerId: "drive-lab",
      readProvider: lab.read,
    });
    ledger.close();
    expect(applied).toMatchObject({ mutationCallCount: 1, state: "Completed" });
    expect(verified).toMatchObject({
      failedActionCount: 0,
      state: "Completed",
      verifiedActionCount: 1,
    });
    expect(replay.mutationCallCount).toBe(0);
    expect(lab.writeCount).toBe(writeCountBeforeReplay);

    const rehearsal: PilotRehearsalInput = {
      artifacts: {
        feedbackPacketPath: packetPath,
        reviewArtifactPath: secondReviewPath,
        transcript: [
          "Changed one synthetic Drive Lab item.",
          `Scanned ${scan.itemCount} items over ${scan.pageCount} pages.`,
          "Built the offline round-one review HTML.",
          "Exported and imported the feedback packet without loss.",
          "Built the offline round-two review HTML with zero network requests.",
          `Dry-run produced ${dryRun.operations.length} ordered operations and zero writes.`,
          `Applied and verified ${verified.verifiedActionCount} write.`,
          `Repeated apply with ${replay.mutationCallCount} writes.`,
        ],
      },
      gateEvidence: PILOT_GATE_IDS.map((gateId, index) => ({
        evidence: `Synthetic rehearsal passed gate ${index + 1}; real access remains gated.`,
        gateId,
        passed: true,
      })),
      metrics: {
        proposals: {
          acceptedUnchanged: 1,
          blocked: 0,
          edited: 0,
          rejected: 0,
          total: 1,
        },
        questions: { asked: 1, reused: 0 },
        review: {
          feedbackFieldsExported: 3,
          feedbackFieldsImported: 3,
          feedbackRounds: 2,
          offlineNetworkRequests: networkRequests,
          packetValidationFailures: 0,
          reviewMinutes: 5,
        },
        scan: {
          coverageGapCount: scan.issues.length,
          enumeratedVisibleItemCount: scan.itemCount,
          expectedVisibleItemCount: 4,
          namedCoverageGapCount: scan.issues.length,
          pageCount: scan.pageCount,
        },
        time: {
          manualBaselineMinutes: 12,
          manualBaselineSampleItemCount: 2,
          operatorMinutes: 8,
        },
        writes: {
          ambiguousActionsExecuted: 0,
          attempts: applied.mutationCallCount,
          noOps: replay.results.filter(
            (result) => result.disposition === "NoOp",
          ).length,
          retries: 0,
          secondRunWrites: replay.mutationCallCount,
          unapprovedWrites: 0,
          verified: verified.verifiedActionCount,
        },
      },
      policyVersion: replanned.plan.policyVersion,
      providerMode: "DRIVE_LAB",
      recordedAt: "2026-08-08T18:40:00.000Z",
      rehearsalId: "pilot-rehearsal-synthetic-1",
      scanGeneration: replanned.plan.scanGeneration,
      version: 1,
    };
    PilotRehearsalInputSchema.parse(rehearsal);
    const scorecardInputPath = join(root, "pilot-rehearsal-input.json");
    writeJson(scorecardInputPath, rehearsal);
    const harness = pilotRuntime(root);
    const result = await runCli(
      [
        "pilot",
        "scorecard",
        "--input",
        scorecardInputPath,
        "--output-dir",
        join(root, "pilot-output"),
        "--json",
      ],
      harness.runtime,
    );

    expect(result.exitCode, JSON.stringify(result.output)).toBe(
      CLI_EXIT_CODES.SUCCESS,
    );
    const output = CliOutputSchema.parse(result.output);
    if (output.command !== "pilot" || output.data.operation !== "scorecard") {
      throw new Error("Expected pilot scorecard output.");
    }
    expect(PilotScorecardSchema.parse(output.data.scorecard)).toMatchObject({
      expansion: { allowed: true },
      metrics: {
        coverage: { percent: 100 },
        idempotency: { passed: true, secondRunWrites: 0 },
        writeVerification: { percent: 100 },
      },
    });
    expect(
      PilotScorecardSchema.parse(
        JSON.parse(readFileSync(output.data.artifactPath, "utf8")) as unknown,
      ),
    ).toEqual(output.data.scorecard);
    expect(output.data.feedbackPacketPath).toBe(packetPath);
    expect(output.data.reviewArtifactPath).toBe(secondReviewPath);
    expect(harness.providerSelections()).toBe(0);
  });

  test("refuses real-provider preflight without Buck's folder and OAuth gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-pilot-google-preflight-"));
    const inputPath = join(root, "preflight.json");
    writeJson(inputPath, {
      approvalPresent: false,
      canaryEffectiveActionCount: 0,
      driveLabGatePassed: true,
      fixtureGatePassed: true,
      localTokenPath: null,
      oauthConsentRecorded: false,
      outputDirectory: join(root, "output"),
      policyVersion: "paisano:1.0.0",
      providerMode: "GOOGLE_DRIVE_REHEARSAL",
      requestedGate: "READ_ONLY",
      scanFresh: false,
      selectedFolderId: null,
      tokenReadAttempted: false,
    });
    const harness = pilotRuntime(root);

    const result = await runCli(
      ["pilot", "preflight", "--input", inputPath, "--json"],
      harness.runtime,
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.REVIEW_REQUIRED);
    expect(result.output).toMatchObject({
      command: "pilot",
      data: {
        operation: "preflight",
        result: {
          blockers: [
            { code: "FOLDER_SCOPE_REQUIRED" },
            { code: "OAUTH_CONSENT_REQUIRED" },
            { code: "LOCAL_TOKEN_PATH_REQUIRED" },
          ],
          providerAccessed: false,
          status: "BLOCKED",
          tokenRead: false,
        },
      },
      status: "REVIEW_REQUIRED",
    });
    expect(harness.providerSelections()).toBe(0);
  });

  test("passes a complete configuration-only Google rehearsal without authorizing the real pilot", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-pilot-google-ready-"));
    const inputPath = join(root, "preflight.json");
    const nonexistentTokenPath = join(
      root,
      "not-created",
      "synthetic-write-token.json",
    );
    writeJson(inputPath, {
      approvalPresent: true,
      canaryEffectiveActionCount: 5,
      driveLabGatePassed: true,
      fixtureGatePassed: true,
      localTokenPath: nonexistentTokenPath,
      oauthConsentRecorded: true,
      outputDirectory: join(root, "output"),
      policyVersion: "paisano:1.0.0",
      providerMode: "GOOGLE_DRIVE_REHEARSAL",
      requestedGate: "EXPANSION",
      scanFresh: true,
      selectedFolderId: "synthetic-selected-folder",
      tokenReadAttempted: false,
    });
    const harness = pilotRuntime(root);

    const result = await runCli(
      ["pilot", "preflight", "--input", inputPath, "--json"],
      harness.runtime,
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(result.output).toMatchObject({
      command: "pilot",
      data: {
        operation: "preflight",
        result: {
          blockers: [],
          configurationOnly: true,
          providerAccessed: false,
          realPilotAuthorized: false,
          status: "READY",
          tokenRead: false,
        },
      },
      status: "SUCCESS",
    });
    expect(existsSync(nonexistentTokenPath)).toBe(false);
    expect(harness.providerSelections()).toBe(0);
  });
});
