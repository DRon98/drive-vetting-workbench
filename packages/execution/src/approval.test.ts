import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangePlanSchema, type ChangePlan } from "@dvw/change-planner";
import { createActionId } from "@dvw/core";
import { describe, expect, test } from "vitest";
import {
  ApprovalValidationError,
  createApprovalArtifact,
  parseApprovalArtifact,
  serializeApprovalArtifact,
  validateApprovalForPlan,
  writeApprovalArtifactCreateOnly,
} from "./index.js";

const observedAt = "2026-08-08T12:00:00.000Z";

function plan(): ChangePlan {
  const scanGeneration = "scan-preflight-1";
  const policyVersion = "1.0.0";
  const desiredState = { name: "2026-08-01 - Hotel Paisano - Invoice.pdf" };
  const actionId = createActionId({
    desiredState,
    planIdentity: `${scanGeneration}\u0000${policyVersion}`,
    targetId: "invoice-1",
    type: "RENAME",
  });
  const action = {
    actionId,
    confidence: 0.95,
    desiredState,
    evidenceIds: ["fact-invoice-name"],
    policyVersion,
    preconditions: {
      modifiedTime: observedAt,
      name: "Invoice draft.pdf",
      parentIds: ["root"],
      permissions: { canRead: true, canWrite: true },
      shortcutTargetId: null,
      trashed: false,
    },
    reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
    reviewState: "Pending" as const,
    scanGeneration,
    targetId: "invoice-1",
    type: "RENAME" as const,
  };
  const canonicalJson = JSON.stringify({
    actions: [
      {
        actionId: action.actionId,
        desiredState: action.desiredState,
        evidenceIds: action.evidenceIds,
        policyVersion: action.policyVersion,
        preconditions: action.preconditions,
        reasonCode: action.reasonCode,
        scanGeneration: action.scanGeneration,
        targetId: action.targetId,
        type: action.type,
      },
    ],
    policyVersion,
    scanGeneration,
    schemaVersion: "dvw.change-plan.v1",
  });
  return ChangePlanSchema.parse({
    actions: [action],
    approvalEligible: true,
    blockers: [],
    canonicalJson,
    effectiveActions: [action],
    explanations: [
      {
        actionId,
        summary: "Rename the invoice under the reviewed rule.",
        writeRequired: true,
      },
    ],
    hashContract: "dvw.change-plan.v1",
    planHash: createHash("sha256").update(canonicalJson).digest("hex"),
    policyVersion,
    scanGeneration,
  });
}

function approval(inputPlan = plan()) {
  return createApprovalArtifact(inputPlan, {
    approvedAt: "2026-08-08T17:00:00.000Z",
    approver: "Buck operator",
    confirmation: `APPROVE ${inputPlan.planHash}`,
    expiresAt: "2026-08-08T18:00:00.000Z",
  });
}

function planWithUnresolvedAction(input: {
  readonly reviewState: "Blocked" | "Pending";
  readonly type: "NEEDS_REVIEW" | "RENAME";
}): ChangePlan {
  const base = plan();
  const source = base.actions[0]!;
  const desiredState = input.type === "NEEDS_REVIEW" ? {} : source.desiredState;
  const action = {
    ...source,
    actionId: createActionId({
      desiredState,
      planIdentity: `${base.scanGeneration}\u0000${base.policyVersion}`,
      targetId: source.targetId,
      type: input.type,
    }),
    desiredState,
    reviewState: input.reviewState,
    type: input.type,
  };
  const canonicalJson = JSON.stringify({
    actions: [
      {
        actionId: action.actionId,
        desiredState: action.desiredState,
        evidenceIds: action.evidenceIds,
        policyVersion: action.policyVersion,
        preconditions: action.preconditions,
        reasonCode: action.reasonCode,
        scanGeneration: action.scanGeneration,
        targetId: action.targetId,
        type: action.type,
      },
    ],
    policyVersion: base.policyVersion,
    scanGeneration: base.scanGeneration,
    schemaVersion: "dvw.change-plan.v1",
  });
  return ChangePlanSchema.parse({
    ...base,
    actions: [action],
    approvalEligible: true,
    blockers: [],
    canonicalJson,
    effectiveActions: [],
    explanations: [
      {
        actionId: action.actionId,
        summary: "This action is not resolved for approval.",
        writeRequired: false,
      },
    ],
    planHash: createHash("sha256").update(canonicalJson).digest("hex"),
  });
}

describe("immutable approval artifact", () => {
  test("binds one explicit operator confirmation to one exact canonical plan", () => {
    const inputPlan = plan();
    const artifact = approval(inputPlan);
    expect(artifact).toMatchObject({
      approvalVersion: "dvw.approval.v1",
      approvedAt: "2026-08-08T17:00:00.000Z",
      approver: "Buck operator",
      expiresAt: "2026-08-08T18:00:00.000Z",
      planHash: inputPlan.planHash,
      policyVersion: inputPlan.policyVersion,
      scanGeneration: inputPlan.scanGeneration,
    });
    expect(artifact.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(artifact)).toBe(true);
    const text = serializeApprovalArtifact(artifact);
    expect(parseApprovalArtifact(text)).toEqual(artifact);
    expect(serializeApprovalArtifact(parseApprovalArtifact(text))).toBe(text);
    expect(
      validateApprovalForPlan(artifact, inputPlan, {
        now: "2026-08-08T17:30:00.000Z",
      }),
    ).toEqual(artifact);
  });

  test("rejects implicit confirmation, blocked plans, expiry errors, and feedback-shaped input", () => {
    const inputPlan = plan();
    expect(() =>
      createApprovalArtifact(inputPlan, {
        approvedAt: "2026-08-08T17:00:00.000Z",
        approver: "Buck operator",
        confirmation: "Accept",
        expiresAt: null,
      }),
    ).toThrow(/APPROVE|confirmation/u);
    expect(() =>
      createApprovalArtifact(
        ChangePlanSchema.parse({
          ...inputPlan,
          approvalEligible: false,
          blockers: [
            {
              actionIds: [inputPlan.actions[0]!.actionId],
              blockerId: "block-feedback-review",
              code: "PROTECTED_ITEM",
              evidenceIds: inputPlan.actions[0]!.evidenceIds,
              message: "The item is protected by policy.",
              targetIds: [inputPlan.actions[0]!.targetId],
            },
          ],
        }),
        {
          approvedAt: "2026-08-08T17:00:00.000Z",
          approver: "Buck operator",
          confirmation: `APPROVE ${inputPlan.planHash}`,
          expiresAt: null,
        },
      ),
    ).toThrow(/eligible|blocker/u);
    expect(() =>
      createApprovalArtifact(inputPlan, {
        approvedAt: "2026-08-08T17:00:00.000Z",
        approver: "Buck operator",
        confirmation: `APPROVE ${inputPlan.planHash}`,
        expiresAt: "2026-08-08T16:59:59.000Z",
      }),
    ).toThrow(/expiry|after/u);
    expect(() =>
      parseApprovalArtifact(
        JSON.stringify({
          actions: [],
          artifactVersion: "dvw.review.v1",
          checksum: "a".repeat(64),
          packetVersion: "dvw.feedback.v1",
          planHash: inputPlan.planHash,
        }),
      ),
    ).toThrow(ApprovalValidationError);
  });

  test("rejects self-consistent plans that hide unresolved or blocked actions", () => {
    for (const inputPlan of [
      planWithUnresolvedAction({
        reviewState: "Pending",
        type: "NEEDS_REVIEW",
      }),
      planWithUnresolvedAction({ reviewState: "Blocked", type: "RENAME" }),
    ]) {
      let caught: unknown;
      try {
        approval(inputPlan);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApprovalValidationError);
      expect((caught as ApprovalValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "PLAN_NOT_ELIGIBLE" }),
        ]),
      );
    }
  });

  test("writes create-only and refuses different bytes at the same path", () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-approval-"));
    const path = join(root, "nested", "approval.json");
    const artifact = approval();
    writeApprovalArtifactCreateOnly(path, artifact);
    writeApprovalArtifactCreateOnly(path, artifact);
    expect(readFileSync(path, "utf8")).toBe(
      serializeApprovalArtifact(artifact),
    );
    writeFileSync(path, "tampered", "utf8");
    expect(() => writeApprovalArtifactCreateOnly(path, artifact)).toThrow(
      /replace|different/u,
    );
    expect(readFileSync(path, "utf8")).toBe("tampered");

    const forged = { ...artifact, checksum: "a".repeat(64) };
    expect(() => serializeApprovalArtifact(forged)).toThrow(
      /checksum|Expected/u,
    );
  });
});
