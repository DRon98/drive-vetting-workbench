import { describe, expect, it } from "vitest";
import * as core from "./index.js";

type TransitionFunction = (from: string, to: string) => string;

function getTransition(name: string): TransitionFunction {
  const transition = Reflect.get(core, name) as unknown;
  expect(transition).toBeTypeOf("function");
  return transition as TransitionFunction;
}

function expectInvalidTransition(
  transition: TransitionFunction,
  from: string,
  to: string,
  machine: string,
): void {
  try {
    transition(from, to);
    expect.fail("Expected an invalid state transition.");
  } catch (error: unknown) {
    expect(error).toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      from,
      machine,
      to,
    });
  }
}

describe("core state machines", () => {
  it("publishes scan generations through staged states", () => {
    const transition = getTransition("transitionScanGeneration");

    expect(transition("Staging", "Complete")).toBe("Complete");
    expect(transition("Complete", "Active")).toBe("Active");
    expect(transition("Active", "Superseded")).toBe("Superseded");
    expectInvalidTransition(transition, "Staging", "Active", "scan-generation");
  });

  it("keeps proposal review separate from approval", () => {
    const transition = getTransition("transitionProposalReview");

    expect(transition("Pending", "Accepted")).toBe("Accepted");
    expect(transition("Pending", "Asked")).toBe("Asked");
    expect(transition("Edited", "Pending")).toBe("Pending");
    expectInvalidTransition(
      transition,
      "Accepted",
      "Pending",
      "proposal-review",
    );
  });

  it("invalidates approval without allowing it to revive", () => {
    const transition = getTransition("transitionApproval");

    expect(transition("Unapproved", "Approved")).toBe("Approved");
    expect(transition("Approved", "Invalidated")).toBe("Invalidated");
    expectInvalidTransition(transition, "Invalidated", "Approved", "approval");
  });

  it("supports partial execution resume but keeps completed runs terminal", () => {
    const transition = getTransition("transitionRun");

    expect(transition("Running", "Partial")).toBe("Partial");
    expect(transition("Partial", "Running")).toBe("Running");
    expect(transition("Partial", "Completed")).toBe("Completed");
    expectInvalidTransition(transition, "Completed", "Running", "run");
  });

  it("uses the typed transition error for every unknown runtime state", () => {
    const machines = [
      ["transitionScanGeneration", "scan-generation", "Staging"],
      ["transitionProposalReview", "proposal-review", "Pending"],
      ["transitionApproval", "approval", "Unapproved"],
      ["transitionRun", "run", "Running"],
    ] as const;

    for (const [transitionName, machine, knownState] of machines) {
      const transition = getTransition(transitionName);
      expectInvalidTransition(transition, "Unknown", knownState, machine);
      expectInvalidTransition(transition, knownState, "Unknown", machine);
    }
  });
});
