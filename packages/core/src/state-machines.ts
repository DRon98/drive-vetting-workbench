import { z } from "zod";
import type { RunState } from "./action-types.js";

export const ScanGenerationStateSchema = z
  .enum(["Staging", "Complete", "Active", "Failed", "Superseded"])
  .meta({ id: "ScanGenerationState" });
export type ScanGenerationState = z.infer<typeof ScanGenerationStateSchema>;

export const ProposalReviewStateSchema = z
  .enum(["Pending", "Accepted", "Rejected", "Edited", "Asked", "Blocked"])
  .meta({ id: "ProposalReviewState" });
export type ProposalReviewState = z.infer<typeof ProposalReviewStateSchema>;

export const ApprovalStateSchema = z
  .enum(["Unapproved", "Approved", "Invalidated", "Expired"])
  .meta({ id: "ApprovalState" });
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export type StateMachineName =
  "scan-generation" | "proposal-review" | "approval" | "run";

export class InvalidStateTransitionError extends Error {
  readonly code = "INVALID_STATE_TRANSITION" as const;

  constructor(
    readonly machine: StateMachineName,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${machine} transition from ${from} to ${to}.`);
    this.name = "InvalidStateTransitionError";
  }
}

const scanTransitions: Record<
  ScanGenerationState,
  readonly ScanGenerationState[]
> = {
  Active: ["Superseded"],
  Complete: ["Active"],
  Failed: [],
  Staging: ["Complete", "Failed"],
  Superseded: [],
};

const proposalTransitions: Record<
  ProposalReviewState,
  readonly ProposalReviewState[]
> = {
  Accepted: [],
  Asked: ["Pending", "Blocked"],
  Blocked: [],
  Edited: ["Pending"],
  Pending: ["Accepted", "Rejected", "Edited", "Asked", "Blocked"],
  Rejected: [],
};

const approvalTransitions: Record<ApprovalState, readonly ApprovalState[]> = {
  Approved: ["Invalidated", "Expired"],
  Expired: [],
  Invalidated: [],
  Unapproved: ["Approved"],
};

const runTransitions: Record<RunState, readonly RunState[]> = {
  Blocked: [],
  Completed: [],
  Failed: [],
  "No-op": [],
  Partial: ["Running", "Completed", "No-op", "Blocked", "Failed"],
  Running: ["Completed", "No-op", "Blocked", "Partial", "Failed"],
};

function transition<State extends string>(
  machine: StateMachineName,
  transitions: Record<State, readonly State[]>,
  from: State,
  to: State,
): State {
  const nextStates = Object.hasOwn(transitions, from)
    ? transitions[from]
    : undefined;
  if (
    nextStates === undefined ||
    !Object.hasOwn(transitions, to) ||
    !nextStates.includes(to)
  ) {
    throw new InvalidStateTransitionError(machine, from, to);
  }
  return to;
}

export function transitionScanGeneration(
  from: ScanGenerationState,
  to: ScanGenerationState,
): ScanGenerationState {
  return transition("scan-generation", scanTransitions, from, to);
}

export function transitionProposalReview(
  from: ProposalReviewState,
  to: ProposalReviewState,
): ProposalReviewState {
  return transition("proposal-review", proposalTransitions, from, to);
}

export function transitionApproval(
  from: ApprovalState,
  to: ApprovalState,
): ApprovalState {
  return transition("approval", approvalTransitions, from, to);
}

export function transitionRun(from: RunState, to: RunState): RunState {
  return transition("run", runTransitions, from, to);
}
