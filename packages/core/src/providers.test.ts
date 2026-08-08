import { describe, expect, it } from "vitest";
import * as core from "./index.js";

function getStringArray(name: string): readonly string[] {
  const value = Reflect.get(core, name) as unknown;
  expect(value).toBeInstanceOf(Array);
  return value as readonly string[];
}

describe("provider capability contracts", () => {
  it("keeps read and mutation methods distinct", () => {
    expect(getStringArray("READ_PROVIDER_METHODS")).toEqual([
      "listItems",
      "getItem",
      "exportItem",
    ]);
    expect(getStringArray("MUTATION_PROVIDER_METHODS")).toEqual([
      "rename",
      "createShortcut",
    ]);
  });

  it("contains no destructive mutation surface", () => {
    const methods = getStringArray("MUTATION_PROVIDER_METHODS");

    expect(methods.join(" ")).not.toMatch(
      /delete|trash|move|overwrite|updateContent/iu,
    );
  });

  it("rejects unknown provider capabilities", () => {
    const schema = Reflect.get(core, "ProviderCapabilitySchema") as {
      safeParse(value: unknown): { success: boolean };
    };

    expect(schema.safeParse("read").success).toBe(true);
    expect(schema.safeParse("mutation").success).toBe(true);
    expect(schema.safeParse("admin").success).toBe(false);
  });
});
