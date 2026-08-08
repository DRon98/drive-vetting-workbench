import {
  preflightApprovedPlan,
  type PreflightApprovedPlanInput,
  type PreflightResult,
} from "./preflight.js";

export interface DryRunResult extends PreflightResult {
  readonly writeCount: 0;
}

export async function dryRunApprovedPlan(
  input: PreflightApprovedPlanInput,
): Promise<DryRunResult> {
  const result = await preflightApprovedPlan(input);
  return { ...result, writeCount: 0 };
}
