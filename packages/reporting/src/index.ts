import { z } from "zod";

export const PILOT_GATE_IDS = [
  "FIXTURE",
  "DRIVE_LAB",
  "READ_ONLY",
  "DECISION",
  "REVIEW",
  "CANARY",
  "FOLDER",
  "EXPANSION",
] as const;

export type PilotGateId = (typeof PILOT_GATE_IDS)[number];

const NonEmptyStringSchema = z.string().trim().min(1);
const CountSchema = z.number().int().nonnegative();
const MinutesSchema = z.number().nonnegative().finite();
const PercentSchema = z.number().min(0).max(100).finite();
const PilotGateIdSchema = z.enum(PILOT_GATE_IDS);

const GateEvidenceSchema = z.strictObject({
  evidence: NonEmptyStringSchema,
  gateId: PilotGateIdSchema,
  passed: z.boolean(),
});

const PilotArtifactsSchema = z.strictObject({
  feedbackPacketPath: NonEmptyStringSchema,
  reviewArtifactPath: NonEmptyStringSchema,
  transcript: z.array(NonEmptyStringSchema).min(1),
});

const PilotMetricsInputSchema = z
  .strictObject({
    proposals: z.strictObject({
      acceptedUnchanged: CountSchema,
      blocked: CountSchema,
      edited: CountSchema,
      rejected: CountSchema,
      total: CountSchema,
    }),
    questions: z.strictObject({ asked: CountSchema, reused: CountSchema }),
    review: z.strictObject({
      feedbackFieldsExported: CountSchema,
      feedbackFieldsImported: CountSchema,
      feedbackRounds: CountSchema,
      offlineNetworkRequests: CountSchema,
      packetValidationFailures: CountSchema,
      reviewMinutes: MinutesSchema,
    }),
    scan: z.strictObject({
      coverageGapCount: CountSchema,
      enumeratedVisibleItemCount: CountSchema,
      expectedVisibleItemCount: CountSchema,
      namedCoverageGapCount: CountSchema,
      pageCount: CountSchema,
    }),
    time: z.strictObject({
      manualBaselineMinutes: MinutesSchema,
      manualBaselineSampleItemCount: z.number().int().positive(),
      operatorMinutes: MinutesSchema,
    }),
    writes: z.strictObject({
      ambiguousActionsExecuted: CountSchema,
      attempts: CountSchema,
      noOps: CountSchema,
      retries: CountSchema,
      secondRunWrites: CountSchema,
      unapprovedWrites: CountSchema,
      verified: CountSchema,
    }),
  })
  .superRefine((metrics, context) => {
    const proposalOutcomes =
      metrics.proposals.acceptedUnchanged +
      metrics.proposals.edited +
      metrics.proposals.rejected +
      metrics.proposals.blocked;
    if (proposalOutcomes !== metrics.proposals.total) {
      context.addIssue({
        code: "custom",
        message: "Proposal outcomes must equal the proposal total.",
        path: ["proposals", "total"],
      });
    }
    if (metrics.questions.reused > metrics.questions.asked) {
      context.addIssue({
        code: "custom",
        message: "Reused questions cannot exceed asked questions.",
        path: ["questions", "reused"],
      });
    }
    if (
      metrics.scan.enumeratedVisibleItemCount >
      metrics.scan.expectedVisibleItemCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Enumerated visible items cannot exceed expected items.",
        path: ["scan", "enumeratedVisibleItemCount"],
      });
    }
    if (metrics.scan.namedCoverageGapCount > metrics.scan.coverageGapCount) {
      context.addIssue({
        code: "custom",
        message: "Named coverage gaps cannot exceed all coverage gaps.",
        path: ["scan", "namedCoverageGapCount"],
      });
    }
    if (
      metrics.review.feedbackFieldsImported >
      metrics.review.feedbackFieldsExported
    ) {
      context.addIssue({
        code: "custom",
        message: "Imported feedback fields cannot exceed exported fields.",
        path: ["review", "feedbackFieldsImported"],
      });
    }
    if (metrics.writes.verified > metrics.writes.attempts) {
      context.addIssue({
        code: "custom",
        message: "Verified writes cannot exceed attempted writes.",
        path: ["writes", "verified"],
      });
    }
  });

export const PilotRehearsalInputSchema = z
  .strictObject({
    artifacts: PilotArtifactsSchema,
    gateEvidence: z.array(GateEvidenceSchema).length(PILOT_GATE_IDS.length),
    metrics: PilotMetricsInputSchema,
    policyVersion: NonEmptyStringSchema,
    providerMode: z.enum(["DRIVE_LAB", "GOOGLE_DRIVE_REHEARSAL"]),
    recordedAt: z.iso.datetime({ offset: true }),
    rehearsalId: NonEmptyStringSchema,
    scanGeneration: NonEmptyStringSchema,
    version: z.literal(1),
  })
  .superRefine((input, context) => {
    for (const [index, gateId] of PILOT_GATE_IDS.entries()) {
      if (input.gateEvidence[index]?.gateId !== gateId) {
        context.addIssue({
          code: "custom",
          message: `Gate ${index + 1} must be ${gateId}.`,
          path: ["gateEvidence", index, "gateId"],
        });
      }
    }
  });

export type PilotRehearsalInput = z.infer<typeof PilotRehearsalInputSchema>;

const GateResultSchema = z.strictObject({
  evidence: NonEmptyStringSchema,
  gateId: PilotGateIdSchema,
  status: z.enum(["PASSED", "BLOCKED", "NOT_STARTED"]),
});

const SafetyThresholdSchema = z.strictObject({
  actual: z.number().finite(),
  kind: z.literal("SAFETY_THRESHOLD"),
  measure: z.enum([
    "VISIBLE_SCAN_COVERAGE",
    "UNAPPROVED_WRITES",
    "VERIFIED_WRITES",
    "REPEATED_WRITES",
    "AMBIGUOUS_ACTIONS_EXECUTED",
    "FEEDBACK_FIELDS_LOST",
    "OFFLINE_NETWORK_REQUESTS",
  ]),
  passed: z.boolean(),
  required: z.union([z.number().finite(), NonEmptyStringSchema]),
});

const LearningTargetSchema = z.strictObject({
  actual: z.number().finite().nullable(),
  kind: z.literal("LEARNING_TARGET"),
  measure: z.enum([
    "CLASSIFIED_WITHOUT_QUESTION",
    "PROPOSALS_ACCEPTED_UNCHANGED",
    "DIRECT_EFFORT_REDUCTION",
    "MECHANICAL_WORK_AUTOMATED",
  ]),
  target: NonEmptyStringSchema,
});

export const PilotScorecardSchema = z.strictObject({
  artifacts: PilotArtifactsSchema,
  expansion: z.strictObject({
    allowed: z.boolean(),
    blockedAtGate: PilotGateIdSchema.nullable(),
    nextCorrectiveAction: NonEmptyStringSchema.nullable(),
  }),
  gates: z.array(GateResultSchema).length(PILOT_GATE_IDS.length),
  learningTargets: z.array(LearningTargetSchema),
  metrics: z.strictObject({
    blockedActionCount: CountSchema,
    coverage: z.strictObject({
      complete: z.boolean(),
      enumeratedVisibleItemCount: CountSchema,
      expectedVisibleItemCount: CountSchema,
      gapCount: CountSchema,
      namedGapCount: CountSchema,
      pageCount: CountSchema,
      percent: PercentSchema,
      safetyPassed: z.boolean(),
    }),
    estimatedTime: z.strictObject({
      estimatedManualMinutesForScope: z.number().finite(),
      estimatedMinutesSaved: z.number().finite(),
      manualBaselineMinutes: MinutesSchema,
      manualBaselineSampleItemCount: z.number().int().positive(),
      measuredBaseline: z.literal(true),
      operatorMinutes: MinutesSchema,
    }),
    feedback: z.strictObject({
      fieldsLost: CountSchema,
      fieldsRoundTripped: CountSchema,
      feedbackRounds: CountSchema,
      offlineNetworkRequests: CountSchema,
      packetValidationFailures: CountSchema,
      reviewMinutes: MinutesSchema,
    }),
    idempotency: z.strictObject({
      passed: z.boolean(),
      secondRunWrites: CountSchema,
    }),
    proposalAcceptance: z.strictObject({
      acceptedUnchanged: CountSchema,
      edited: CountSchema,
      percent: PercentSchema.nullable(),
      rejected: CountSchema,
      total: CountSchema,
    }),
    questionRate: z.strictObject({
      asked: CountSchema,
      percent: PercentSchema.nullable(),
      reused: CountSchema,
    }),
    writeVerification: z.strictObject({
      attempts: CountSchema,
      noOps: CountSchema,
      percent: PercentSchema,
      retries: CountSchema,
      verified: CountSchema,
    }),
  }),
  policyVersion: NonEmptyStringSchema,
  providerMode: z.enum(["DRIVE_LAB", "GOOGLE_DRIVE_REHEARSAL"]),
  recordedAt: z.iso.datetime({ offset: true }),
  rehearsalId: NonEmptyStringSchema,
  safetyThresholds: z.array(SafetyThresholdSchema),
  scanGeneration: NonEmptyStringSchema,
  version: z.literal(1),
});

export type PilotScorecard = z.infer<typeof PilotScorecardSchema>;

function percent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function requiredPercent(numerator: number, denominator: number): number {
  return percent(numerator, denominator) ?? 100;
}

const gateCorrectiveActions: Record<PilotGateId, string> = {
  CANARY: "Reduce the canary to at most 5 low-risk effective actions.",
  DECISION: "Resolve the remaining material questions and store their scope.",
  DRIVE_LAB:
    "Complete the Drive Lab and offline HTML feedback rehearsal first.",
  EXPANSION: "Correct every failed safety threshold before adding a folder.",
  FIXTURE: "Pass all synthetic and adversarial verification first.",
  FOLDER: "Make the second approved apply produce zero second-run writes.",
  READ_ONLY:
    "Record one folder scope and explicit OAuth consent for a read-only scan.",
  REVIEW: "Review the regenerated HTML and approve its exact final plan hash.",
};

const safetyCorrectiveActions: Record<
  z.infer<typeof SafetyThresholdSchema>["measure"],
  string
> = {
  AMBIGUOUS_ACTIONS_EXECUTED:
    "Block ambiguous actions and resolve them before execution.",
  FEEDBACK_FIELDS_LOST:
    "Fix the feedback round trip until it loses zero supported fields.",
  OFFLINE_NETWORK_REQUESTS:
    "Remove every review HTML network request before continuing.",
  REPEATED_WRITES:
    "Fix idempotency until the second apply makes zero second-run writes.",
  UNAPPROVED_WRITES:
    "Stop all writes and restore the exact approval boundary before continuing.",
  VERIFIED_WRITES:
    "Re-fetch and verify every successful write before continuing.",
  VISIBLE_SCAN_COVERAGE:
    "Complete the visible scan or name every remaining coverage gap.",
};

export function buildPilotScorecard(
  inputValue: PilotRehearsalInput,
): PilotScorecard {
  const input = PilotRehearsalInputSchema.parse(inputValue);
  const coveragePercent = requiredPercent(
    input.metrics.scan.enumeratedVisibleItemCount,
    input.metrics.scan.expectedVisibleItemCount,
  );
  const coverageComplete =
    input.metrics.scan.enumeratedVisibleItemCount ===
      input.metrics.scan.expectedVisibleItemCount &&
    input.metrics.scan.coverageGapCount === 0;
  const coverageSafetyPassed =
    coverageComplete ||
    input.metrics.scan.namedCoverageGapCount ===
      input.metrics.scan.coverageGapCount;
  const writeVerificationPercent = requiredPercent(
    input.metrics.writes.verified,
    input.metrics.writes.attempts,
  );
  const fieldsLost =
    input.metrics.review.feedbackFieldsExported -
    input.metrics.review.feedbackFieldsImported;
  const estimatedManualMinutesForScope = Number(
    (
      (input.metrics.time.manualBaselineMinutes /
        input.metrics.time.manualBaselineSampleItemCount) *
      input.metrics.scan.expectedVisibleItemCount
    ).toFixed(2),
  );
  const estimatedMinutesSaved = Number(
    (
      estimatedManualMinutesForScope - input.metrics.time.operatorMinutes
    ).toFixed(2),
  );
  const directEffortReduction = percent(
    estimatedMinutesSaved,
    estimatedManualMinutesForScope,
  );
  const approvedEffectiveActions =
    input.metrics.writes.attempts + input.metrics.writes.noOps;
  const mechanicalWorkAutomated = percent(
    input.metrics.writes.verified + input.metrics.writes.noOps,
    approvedEffectiveActions,
  );
  const classifiedWithoutQuestion = percent(
    Math.max(
      0,
      input.metrics.scan.enumeratedVisibleItemCount -
        input.metrics.questions.asked,
    ),
    input.metrics.scan.enumeratedVisibleItemCount,
  );

  const safetyThresholds: z.infer<typeof SafetyThresholdSchema>[] = [
    {
      actual: coveragePercent,
      kind: "SAFETY_THRESHOLD",
      measure: "VISIBLE_SCAN_COVERAGE",
      passed: coverageSafetyPassed,
      required: "100% or every gap named",
    },
    {
      actual: input.metrics.writes.unapprovedWrites,
      kind: "SAFETY_THRESHOLD",
      measure: "UNAPPROVED_WRITES",
      passed: input.metrics.writes.unapprovedWrites === 0,
      required: 0,
    },
    {
      actual: writeVerificationPercent,
      kind: "SAFETY_THRESHOLD",
      measure: "VERIFIED_WRITES",
      passed: writeVerificationPercent === 100,
      required: 100,
    },
    {
      actual: input.metrics.writes.secondRunWrites,
      kind: "SAFETY_THRESHOLD",
      measure: "REPEATED_WRITES",
      passed: input.metrics.writes.secondRunWrites === 0,
      required: 0,
    },
    {
      actual: input.metrics.writes.ambiguousActionsExecuted,
      kind: "SAFETY_THRESHOLD",
      measure: "AMBIGUOUS_ACTIONS_EXECUTED",
      passed: input.metrics.writes.ambiguousActionsExecuted === 0,
      required: 0,
    },
    {
      actual: fieldsLost,
      kind: "SAFETY_THRESHOLD",
      measure: "FEEDBACK_FIELDS_LOST",
      passed: fieldsLost === 0,
      required: 0,
    },
    {
      actual: input.metrics.review.offlineNetworkRequests,
      kind: "SAFETY_THRESHOLD",
      measure: "OFFLINE_NETWORK_REQUESTS",
      passed: input.metrics.review.offlineNetworkRequests === 0,
      required: 0,
    },
  ];

  const firstFailedEvidenceIndex = input.gateEvidence.findIndex(
    (entry) => !entry.passed,
  );
  const firstFailedThreshold = safetyThresholds.find((entry) => !entry.passed);
  const thresholdOnlyFailure =
    firstFailedEvidenceIndex === -1 && firstFailedThreshold !== undefined;
  const blockedAtGate =
    firstFailedEvidenceIndex >= 0
      ? (PILOT_GATE_IDS[firstFailedEvidenceIndex] ?? null)
      : thresholdOnlyFailure
        ? "EXPANSION"
        : null;
  const gates = input.gateEvidence.map((entry, index) => {
    let status: z.infer<typeof GateResultSchema>["status"];
    if (firstFailedEvidenceIndex >= 0) {
      status =
        index < firstFailedEvidenceIndex
          ? "PASSED"
          : index === firstFailedEvidenceIndex
            ? "BLOCKED"
            : "NOT_STARTED";
    } else if (thresholdOnlyFailure && entry.gateId === "EXPANSION") {
      status = "BLOCKED";
    } else {
      status = "PASSED";
    }
    return { evidence: entry.evidence, gateId: entry.gateId, status };
  });

  const nextCorrectiveAction =
    firstFailedThreshold !== undefined
      ? safetyCorrectiveActions[firstFailedThreshold.measure]
      : blockedAtGate === null
        ? null
        : gateCorrectiveActions[blockedAtGate];

  return PilotScorecardSchema.parse({
    artifacts: input.artifacts,
    expansion: {
      allowed:
        firstFailedEvidenceIndex === -1 && firstFailedThreshold === undefined,
      blockedAtGate,
      nextCorrectiveAction,
    },
    gates,
    learningTargets: [
      {
        actual: classifiedWithoutQuestion,
        kind: "LEARNING_TARGET",
        measure: "CLASSIFIED_WITHOUT_QUESTION",
        target: "At least 70% after the first calibration folder",
      },
      {
        actual: percent(
          input.metrics.proposals.acceptedUnchanged,
          input.metrics.proposals.total,
        ),
        kind: "LEARNING_TARGET",
        measure: "PROPOSALS_ACCEPTED_UNCHANGED",
        target: "At least 80% before expansion",
      },
      {
        actual: directEffortReduction,
        kind: "LEARNING_TARGET",
        measure: "DIRECT_EFFORT_REDUCTION",
        target: "Measure 50% to 70% after calibration",
      },
      {
        actual: mechanicalWorkAutomated,
        kind: "LEARNING_TARGET",
        measure: "MECHANICAL_WORK_AUTOMATED",
        target: "Measure 80% to 95% against approved actions",
      },
    ],
    metrics: {
      blockedActionCount: input.metrics.proposals.blocked,
      coverage: {
        complete: coverageComplete,
        enumeratedVisibleItemCount:
          input.metrics.scan.enumeratedVisibleItemCount,
        expectedVisibleItemCount: input.metrics.scan.expectedVisibleItemCount,
        gapCount: input.metrics.scan.coverageGapCount,
        namedGapCount: input.metrics.scan.namedCoverageGapCount,
        pageCount: input.metrics.scan.pageCount,
        percent: coveragePercent,
        safetyPassed: coverageSafetyPassed,
      },
      estimatedTime: {
        estimatedManualMinutesForScope,
        estimatedMinutesSaved,
        manualBaselineMinutes: input.metrics.time.manualBaselineMinutes,
        manualBaselineSampleItemCount:
          input.metrics.time.manualBaselineSampleItemCount,
        measuredBaseline: true,
        operatorMinutes: input.metrics.time.operatorMinutes,
      },
      feedback: {
        fieldsLost,
        fieldsRoundTripped: input.metrics.review.feedbackFieldsImported,
        feedbackRounds: input.metrics.review.feedbackRounds,
        offlineNetworkRequests: input.metrics.review.offlineNetworkRequests,
        packetValidationFailures: input.metrics.review.packetValidationFailures,
        reviewMinutes: input.metrics.review.reviewMinutes,
      },
      idempotency: {
        passed: input.metrics.writes.secondRunWrites === 0,
        secondRunWrites: input.metrics.writes.secondRunWrites,
      },
      proposalAcceptance: {
        acceptedUnchanged: input.metrics.proposals.acceptedUnchanged,
        edited: input.metrics.proposals.edited,
        percent: percent(
          input.metrics.proposals.acceptedUnchanged,
          input.metrics.proposals.total,
        ),
        rejected: input.metrics.proposals.rejected,
        total: input.metrics.proposals.total,
      },
      questionRate: {
        asked: input.metrics.questions.asked,
        percent: percent(
          input.metrics.questions.asked,
          input.metrics.scan.enumeratedVisibleItemCount,
        ),
        reused: input.metrics.questions.reused,
      },
      writeVerification: {
        attempts: input.metrics.writes.attempts,
        noOps: input.metrics.writes.noOps,
        percent: writeVerificationPercent,
        retries: input.metrics.writes.retries,
        verified: input.metrics.writes.verified,
      },
    },
    policyVersion: input.policyVersion,
    providerMode: input.providerMode,
    recordedAt: input.recordedAt,
    rehearsalId: input.rehearsalId,
    safetyThresholds,
    scanGeneration: input.scanGeneration,
    version: 1,
  });
}

export function serializePilotScorecard(scorecard: PilotScorecard): string {
  return `${JSON.stringify(PilotScorecardSchema.parse(scorecard), null, 2)}\n`;
}

export const PilotPreflightInputSchema = z.strictObject({
  approvalPresent: z.boolean(),
  canaryEffectiveActionCount: CountSchema,
  driveLabGatePassed: z.boolean(),
  fixtureGatePassed: z.boolean(),
  localTokenPath: NonEmptyStringSchema.nullable(),
  oauthConsentRecorded: z.boolean(),
  outputDirectory: NonEmptyStringSchema,
  policyVersion: NonEmptyStringSchema,
  providerMode: z.enum(["DRIVE_LAB", "GOOGLE_DRIVE_REHEARSAL"]),
  requestedGate: PilotGateIdSchema,
  scanFresh: z.boolean(),
  selectedFolderId: NonEmptyStringSchema.nullable(),
  tokenReadAttempted: z.boolean(),
});

export type PilotPreflightInput = z.infer<typeof PilotPreflightInputSchema>;

const PreflightBlockerSchema = z.strictObject({
  code: z.enum([
    "FIXTURE_GATE_REQUIRED",
    "DRIVE_LAB_GATE_REQUIRED",
    "FOLDER_SCOPE_REQUIRED",
    "OAUTH_CONSENT_REQUIRED",
    "LOCAL_TOKEN_PATH_REQUIRED",
    "TOKEN_READ_FORBIDDEN_IN_REHEARSAL",
    "FRESH_SCAN_REQUIRED",
    "APPROVAL_REQUIRED",
    "CANARY_LIMIT_EXCEEDED",
  ]),
  message: NonEmptyStringSchema,
});

export const PilotPreflightResultSchema = z.strictObject({
  blockers: z.array(PreflightBlockerSchema),
  canaryLimit: z.literal(5),
  configurationOnly: z.literal(true),
  nextCorrectiveAction: NonEmptyStringSchema.nullable(),
  providerAccessed: z.literal(false),
  realPilotAuthorized: z.literal(false),
  requestedGate: PilotGateIdSchema,
  status: z.enum(["READY", "BLOCKED"]),
  tokenRead: z.literal(false),
});

export type PilotPreflightResult = z.infer<typeof PilotPreflightResultSchema>;

const preflightCorrectiveActions: Record<
  z.infer<typeof PreflightBlockerSchema>["code"],
  string
> = {
  APPROVAL_REQUIRED:
    "Approve the exact final plan hash before the canary or folder apply.",
  CANARY_LIMIT_EXCEEDED:
    "Reduce the canary to at most 5 low-risk effective actions.",
  DRIVE_LAB_GATE_REQUIRED:
    "Complete the Drive Lab and offline HTML feedback rehearsal first.",
  FIXTURE_GATE_REQUIRED: "Pass all synthetic and adversarial tests first.",
  FOLDER_SCOPE_REQUIRED:
    "Record one explicit folder scope before the read-only pilot.",
  FRESH_SCAN_REQUIRED:
    "Run a fresh read-only scan and name every coverage gap.",
  LOCAL_TOKEN_PATH_REQUIRED:
    "Configure the local token path after explicit OAuth consent.",
  OAUTH_CONSENT_REQUIRED:
    "Obtain and record Buck's explicit OAuth consent for the selected folder.",
  TOKEN_READ_FORBIDDEN_IN_REHEARSAL:
    "Repeat the offline preflight without opening any token file.",
};

export function evaluatePilotPreflight(
  inputValue: PilotPreflightInput,
): PilotPreflightResult {
  const input = PilotPreflightInputSchema.parse(inputValue);
  const blockers: z.infer<typeof PreflightBlockerSchema>[] = [];
  if (!input.fixtureGatePassed) {
    blockers.push({
      code: "FIXTURE_GATE_REQUIRED",
      message: "The fixture gate has not passed.",
    });
  }
  if (!input.driveLabGatePassed) {
    blockers.push({
      code: "DRIVE_LAB_GATE_REQUIRED",
      message: "The Drive Lab rehearsal gate has not passed.",
    });
  }

  const requestedGateIndex = PILOT_GATE_IDS.indexOf(input.requestedGate);
  if (
    input.providerMode === "GOOGLE_DRIVE_REHEARSAL" &&
    requestedGateIndex >= PILOT_GATE_IDS.indexOf("READ_ONLY")
  ) {
    if (input.selectedFolderId === null) {
      blockers.push({
        code: "FOLDER_SCOPE_REQUIRED",
        message: "Google Drive mode needs one explicit folder scope.",
      });
    }
    if (!input.oauthConsentRecorded) {
      blockers.push({
        code: "OAUTH_CONSENT_REQUIRED",
        message: "Google Drive mode needs recorded OAuth consent.",
      });
    }
    if (input.localTokenPath === null) {
      blockers.push({
        code: "LOCAL_TOKEN_PATH_REQUIRED",
        message: "Google Drive mode needs a configured local token path.",
      });
    }
  }
  if (input.tokenReadAttempted) {
    blockers.push({
      code: "TOKEN_READ_FORBIDDEN_IN_REHEARSAL",
      message: "The offline rehearsal must not read a token file.",
    });
  }
  if (
    requestedGateIndex >= PILOT_GATE_IDS.indexOf("DECISION") &&
    !input.scanFresh
  ) {
    blockers.push({
      code: "FRESH_SCAN_REQUIRED",
      message: "This gate needs a fresh selected-folder scan.",
    });
  }
  if (
    requestedGateIndex >= PILOT_GATE_IDS.indexOf("CANARY") &&
    !input.approvalPresent
  ) {
    blockers.push({
      code: "APPROVAL_REQUIRED",
      message: "This gate needs approval for the exact final plan hash.",
    });
  }
  if (
    requestedGateIndex >= PILOT_GATE_IDS.indexOf("CANARY") &&
    input.canaryEffectiveActionCount > 5
  ) {
    blockers.push({
      code: "CANARY_LIMIT_EXCEEDED",
      message: `The canary has ${input.canaryEffectiveActionCount} effective actions. The default limit is 5.`,
    });
  }
  const firstBlocker = blockers[0];
  return PilotPreflightResultSchema.parse({
    blockers,
    canaryLimit: 5,
    configurationOnly: true,
    nextCorrectiveAction:
      firstBlocker === undefined
        ? null
        : preflightCorrectiveActions[firstBlocker.code],
    providerAccessed: false,
    realPilotAuthorized: false,
    requestedGate: input.requestedGate,
    status: blockers.length === 0 ? "READY" : "BLOCKED",
    tokenRead: false,
  });
}
