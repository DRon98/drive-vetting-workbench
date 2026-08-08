import { describe, expect, it } from "vitest";
import * as core from "./index.js";

interface ActionIdentityInput {
  desiredState: Record<string, unknown>;
  displayOrder?: number;
  planIdentity: string;
  targetId: string;
  type: string;
}

type CreateActionId = (input: ActionIdentityInput) => string;

function getCreateActionId(): CreateActionId {
  const createActionId = Reflect.get(core, "createActionId") as unknown;
  expect(createActionId).toBeTypeOf("function");
  return createActionId as CreateActionId;
}

describe("deterministic action identity", () => {
  it("ignores object-key and display order", () => {
    const createActionId = getCreateActionId();
    const first = createActionId({
      desiredState: {
        name: "Investor Update",
        parentIds: ["folder-a", "folder-b"],
      },
      displayOrder: 1,
      planIdentity: "plan-fixture",
      targetId: "file-123",
      type: "CREATE_SHORTCUT",
    });
    const second = createActionId({
      desiredState: {
        parentIds: ["folder-a", "folder-b"],
        name: "Investor Update",
      },
      displayOrder: 99,
      planIdentity: "plan-fixture",
      targetId: "file-123",
      type: "CREATE_SHORTCUT",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^act_[a-f0-9]{32}$/u);
  });

  it("preserves array order because desired-state arrays can be ordered", () => {
    const createActionId = getCreateActionId();
    const base = {
      planIdentity: "plan-fixture",
      targetId: "file-123",
      type: "CREATE_SHORTCUT",
    };

    expect(
      createActionId({
        ...base,
        desiredState: { parentIds: ["folder-a", "folder-b"] },
      }),
    ).not.toBe(
      createActionId({
        ...base,
        desiredState: { parentIds: ["folder-b", "folder-a"] },
      }),
    );
  });

  it("rejects identity inputs that JSON cannot represent losslessly", () => {
    const createActionId = getCreateActionId();
    const invalidValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      new Date("2026-08-07T12:00:00.000Z"),
    ];

    for (const value of invalidValues) {
      expect(() =>
        createActionId({
          desiredState: { value },
          planIdentity: "plan-fixture",
          targetId: "file-123",
          type: "RENAME",
        }),
      ).toThrow(TypeError);
    }
  });

  it("rejects non-ordinary arrays instead of collapsing their structure", () => {
    const createActionId = getCreateActionId();
    const sparse = Array<unknown>(1);
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => "folder-a",
    });
    accessor.length = 1;
    const withExtraProperty = ["folder-a"];
    Object.defineProperty(withExtraProperty, "label", {
      enumerable: true,
      value: "ignored by JSON.stringify",
    });
    class ArraySubclass extends Array<unknown> {}

    for (const value of [
      sparse,
      accessor,
      withExtraProperty,
      new ArraySubclass("folder-a"),
    ]) {
      expect(() =>
        createActionId({
          desiredState: { value },
          planIdentity: "plan-fixture",
          targetId: "file-123",
          type: "RENAME",
        }),
      ).toThrow(TypeError);
    }
  });

  it("does not depend on locale-sensitive object-key ordering", () => {
    const createActionId = getCreateActionId();
    const originalLocaleCompare = Object.getOwnPropertyDescriptor(
      String.prototype,
      "localeCompare",
    );
    expect(originalLocaleCompare).toBeDefined();
    Object.defineProperty(String.prototype, "localeCompare", {
      configurable: true,
      value: () => {
        throw new Error("localeCompare must not determine an action ID");
      },
    });

    try {
      expect(
        createActionId({
          desiredState: { zeta: 1, éclair: 2, alpha: 3 },
          planIdentity: "plan-fixture",
          targetId: "file-123",
          type: "RENAME",
        }),
      ).toMatch(/^act_[a-f0-9]{32}$/u);
    } finally {
      if (originalLocaleCompare !== undefined) {
        Object.defineProperty(
          String.prototype,
          "localeCompare",
          originalLocaleCompare,
        );
      }
    }
  });

  it("changes when an authorization-relevant input changes", () => {
    const createActionId = getCreateActionId();
    const base = {
      desiredState: { name: "Investor Update" },
      planIdentity: "plan-fixture",
      targetId: "file-123",
      type: "RENAME",
    };

    expect(createActionId(base)).not.toBe(
      createActionId({ ...base, targetId: "file-456" }),
    );
    expect(createActionId(base)).not.toBe(
      createActionId({
        ...base,
        desiredState: { name: "Different Name" },
      }),
    );
  });
});
