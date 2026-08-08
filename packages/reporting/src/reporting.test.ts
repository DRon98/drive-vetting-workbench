import { describe, expect, test } from "vitest";
import {
  PILOT_GATE_IDS,
  PilotScorecardSchema,
  buildPilotScorecard,
  evaluatePilotPreflight,
  type PilotRehearsalInput,
} from "./index.js";

function safeRehearsal(
  overrides: Partial<PilotRehearsalInput["metrics"]> = {},
): PilotRehearsalInput {
  return {
    artifacts: {
      feedbackPacketPath: "/synthetic/pilot/feedback-round-1.json",
      reviewArtifactPath: "/synthetic/pilot/review-round-2.html",
      transcript: [
        "Changed one Drive Lab item.",
        "Scanned four items over two pages.",
        "Exported and imported feedback without loss.",
        "Applied one approved write and verified it.",
        "Repeated apply with zero writes.",
      ],
    },
    gateEvidence: PILOT_GATE_IDS.map((gateId, index) => ({
      evidence: `Synthetic gate ${index + 1} passed in order.`,
      gateId,
      passed: true,
    })),
    metrics: {
      review: {
        feedbackFieldsExported: 4,
        feedbackFieldsImported: 4,
        feedbackRounds: 2,
        offlineNetworkRequests: 0,
        packetValidationFailures: 0,
        reviewMinutes: 5,
      },
      scan: {
        coverageGapCount: 0,
        enumeratedVisibleItemCount: 4,
        expectedVisibleItemCount: 4,
        namedCoverageGapCount: 0,
        pageCount: 2,
      },
      proposals: {
        acceptedUnchanged: 1,
        blocked: 0,
        edited: 1,
        rejected: 0,
        total: 2,
      },
      questions: { asked: 1, reused: 1 },
      time: {
        manualBaselineMinutes: 12,
        manualBaselineSampleItemCount: 2,
        operatorMinutes: 8,
      },
      writes: {
        ambiguousActionsExecuted: 0,
        attempts: 1,
        noOps: 1,
        retries: 0,
        secondRunWrites: 0,
        unapprovedWrites: 0,
        verified: 1,
      },
      ...overrides,
    },
    policyVersion: "paisano:1.0.0",
    providerMode: "DRIVE_LAB",
    recordedAt: "2026-08-08T18:00:00.000Z",
    rehearsalId: "pilot-rehearsal-synthetic-1",
    scanGeneration: "scan-pilot-synthetic-1",
    version: 1,
  };
}

describe("pilot scorecards", () => {
  test("validates the published synthetic pilot scorecard", () => {
    const path = new URL(
      "../../../examples/pilot-scorecard.json",
      import.meta.url,
    );
    const scorecard = JSON.parse(readFileSync(path, "utf8")) as unknown;

    expect(PilotScorecardSchema.parse(scorecard)).toMatchObject({
      expansion: { allowed: true },
      providerMode: "DRIVE_LAB",
      version: 1,
    });
  });
  test("keeps the eight gates ordered and separates safety thresholds from learning targets", () => {
    const scorecard = buildPilotScorecard(safeRehearsal());

    expect(scorecard.gates.map((gate) => gate.gateId)).toEqual(PILOT_GATE_IDS);
    expect(scorecard.gates.every((gate) => gate.status === "PASSED")).toBe(
      true,
    );
    expect(scorecard.safetyThresholds.map((entry) => entry.kind)).toEqual(
      Array(scorecard.safetyThresholds.length).fill("SAFETY_THRESHOLD"),
    );
    expect(scorecard.learningTargets.map((entry) => entry.kind)).toEqual(
      Array(scorecard.learningTargets.length).fill("LEARNING_TARGET"),
    );
    expect(scorecard.metrics).toMatchObject({
      blockedActionCount: 0,
      coverage: { gapCount: 0, percent: 100, safetyPassed: true },
      estimatedTime: {
        estimatedManualMinutesForScope: 24,
        estimatedMinutesSaved: 16,
        measuredBaseline: true,
      },
      idempotency: { passed: true, secondRunWrites: 0 },
      proposalAcceptance: { percent: 50 },
      questionRate: { percent: 25, reused: 1 },
      writeVerification: { percent: 100, verified: 1 },
    });
    expect(scorecard.artifacts.feedbackPacketPath).toBe(
      "/synthetic/pilot/feedback-round-1.json",
    );
    expect(scorecard.artifacts.reviewArtifactPath).toBe(
      "/synthetic/pilot/review-round-2.html",
    );
    expect(scorecard.artifacts.transcript).toContain(
      "Exported and imported feedback without loss.",
    );
    expect(scorecard.expansion).toEqual({
      allowed: true,
      blockedAtGate: null,
      nextCorrectiveAction: null,
    });
  });

  test("stops expansion at the first failed gate and names the corrective action", () => {
    const input = safeRehearsal({
      writes: {
        ambiguousActionsExecuted: 0,
        attempts: 1,
        noOps: 0,
        retries: 1,
        secondRunWrites: 1,
        unapprovedWrites: 0,
        verified: 1,
      },
    });
    input.gateEvidence[6] = {
      evidence: "The second apply made one repeated write.",
      gateId: "FOLDER",
      passed: false,
    };

    const scorecard = buildPilotScorecard(input);

    expect(scorecard.gates[6]).toMatchObject({
      gateId: "FOLDER",
      status: "BLOCKED",
    });
    expect(scorecard.gates[7]).toMatchObject({
      gateId: "EXPANSION",
      status: "NOT_STARTED",
    });
    expect(scorecard.expansion).toMatchObject({
      allowed: false,
      blockedAtGate: "FOLDER",
    });
    expect(scorecard.expansion.nextCorrectiveAction).toContain(
      "second-run writes",
    );
    expect(
      scorecard.safetyThresholds.find(
        (entry) => entry.measure === "REPEATED_WRITES",
      ),
    ).toMatchObject({ actual: 1, passed: false, required: 0 });
  });

  test("accepts fully named coverage gaps but reports incomplete raw coverage", () => {
    const scorecard = buildPilotScorecard(
      safeRehearsal({
        scan: {
          coverageGapCount: 2,
          enumeratedVisibleItemCount: 8,
          expectedVisibleItemCount: 10,
          namedCoverageGapCount: 2,
          pageCount: 3,
        },
      }),
    );

    expect(scorecard.metrics.coverage).toEqual({
      complete: false,
      enumeratedVisibleItemCount: 8,
      expectedVisibleItemCount: 10,
      gapCount: 2,
      namedGapCount: 2,
      pageCount: 3,
      percent: 80,
      safetyPassed: true,
    });
  });
});

describe("pilot preflight", () => {
  test("refuses Google Drive without an explicit folder and recorded OAuth consent", () => {
    const result = evaluatePilotPreflight({
      approvalPresent: false,
      canaryEffectiveActionCount: 0,
      driveLabGatePassed: true,
      fixtureGatePassed: true,
      localTokenPath: null,
      oauthConsentRecorded: false,
      outputDirectory: "/synthetic/pilot-output",
      policyVersion: "paisano:1.0.0",
      providerMode: "GOOGLE_DRIVE_REHEARSAL",
      requestedGate: "READ_ONLY",
      scanFresh: false,
      selectedFolderId: null,
      tokenReadAttempted: false,
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "FOLDER_SCOPE_REQUIRED",
      "OAUTH_CONSENT_REQUIRED",
      "LOCAL_TOKEN_PATH_REQUIRED",
    ]);
    expect(result.nextCorrectiveAction).toBe(
      "Record one explicit folder scope before the read-only pilot.",
    );
    expect(result.providerAccessed).toBe(false);
    expect(result.tokenRead).toBe(false);
  });

  test("blocks a canary above five effective actions before provider access", () => {
    const result = evaluatePilotPreflight({
      approvalPresent: true,
      canaryEffectiveActionCount: 6,
      driveLabGatePassed: true,
      fixtureGatePassed: true,
      localTokenPath: "/synthetic/config/tokens/write.json",
      oauthConsentRecorded: true,
      outputDirectory: "/synthetic/pilot-output",
      policyVersion: "paisano:1.0.0",
      providerMode: "GOOGLE_DRIVE_REHEARSAL",
      requestedGate: "CANARY",
      scanFresh: true,
      selectedFolderId: "synthetic-folder-id",
      tokenReadAttempted: false,
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.blockers).toEqual([
      {
        code: "CANARY_LIMIT_EXCEEDED",
        message: "The canary has 6 effective actions. The default limit is 5.",
      },
    ]);
    expect(result.nextCorrectiveAction).toBe(
      "Reduce the canary to at most 5 low-risk effective actions.",
    );
    expect(result.providerAccessed).toBe(false);
    expect(result.tokenRead).toBe(false);
  });
});
import { readFileSync } from "node:fs";
