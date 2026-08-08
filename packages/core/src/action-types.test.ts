import { describe, expect, it } from "vitest";
import * as core from "./index.js";

interface RuntimeSchema {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}

function getSchema(name: string): RuntimeSchema {
  const schema = Reflect.get(core, name) as unknown;
  expect(schema).toBeDefined();
  return schema as RuntimeSchema;
}

describe("version 1 action contract", () => {
  it("accepts exactly the five non-destructive action types", () => {
    const actionTypeSchema = getSchema("ActionTypeSchema");
    const allowed = [
      "KEEP",
      "RENAME",
      "CREATE_SHORTCUT",
      "PRESERVE_ARCHIVE",
      "NEEDS_REVIEW",
    ];

    expect(allowed.map((value) => actionTypeSchema.parse(value))).toEqual(
      allowed,
    );
    expect(actionTypeSchema.safeParse("DELETE").success).toBe(false);
    expect(actionTypeSchema.safeParse("MOVE").success).toBe(false);
    expect(actionTypeSchema.safeParse("TRASH").success).toBe(false);
    expect(actionTypeSchema.safeParse("OVERWRITE_CONTENT").success).toBe(false);
  });

  it("accepts exactly the six run states", () => {
    const runStateSchema = getSchema("RunStateSchema");
    const allowed = [
      "Running",
      "Completed",
      "No-op",
      "Blocked",
      "Partial",
      "Failed",
    ];

    expect(allowed.map((value) => runStateSchema.parse(value))).toEqual(
      allowed,
    );
    expect(runStateSchema.safeParse("Succeeded").success).toBe(false);
    expect(runStateSchema.safeParse("Deleted").success).toBe(false);
  });
});
