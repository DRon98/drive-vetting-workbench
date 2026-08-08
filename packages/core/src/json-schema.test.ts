import { describe, expect, it } from "vitest";
import * as core from "./index.js";

type JsonSchemaMap = Record<string, Record<string, unknown>>;

function getSchemaMap(name: string): JsonSchemaMap {
  const schemas = Reflect.get(core, name) as unknown;
  expect(schemas).toBeDefined();
  return schemas as JsonSchemaMap;
}

describe("JSON Schema exports", () => {
  it("exports every persisted core record as strict Draft 2020-12 schema", () => {
    const schemas = getSchemaMap("coreJsonSchemas");

    expect(Object.keys(schemas).sort()).toEqual([
      "ApprovedPlan",
      "DecisionRecord",
      "EvidenceBundle",
      "ObservedItem",
      "OperationReceipt",
      "PolicyPack",
      "ProposedAction",
      "ReviewArtifactManifest",
      "ReviewFeedbackPacket",
      "RunLedger",
      "ScanCoverage",
      "SimulatedDriveManifest",
    ]);
    for (const schema of Object.values(schemas)) {
      expect(schema.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it("exports the read-only MCP-facing record set", () => {
    const schemas = getSchemaMap("mcpJsonSchemas");

    expect(Object.keys(schemas).sort()).toEqual([
      "DecisionRecord",
      "EvidenceBundle",
      "ObservedItem",
      "OperationReceipt",
      "ProposedAction",
      "RunLedger",
      "ScanCoverage",
    ]);
  });

  it("contains no forbidden action in generated schemas", () => {
    const serialized = JSON.stringify(getSchemaMap("coreJsonSchemas"));

    expect(serialized).not.toMatch(/DELETE|TRASH|MOVE|OVERWRITE_CONTENT/u);
    expect(serialized).toContain("CREATE_SHORTCUT");
    expect(serialized).toContain("PRESERVE_ARCHIVE");
  });

  it("matches the reviewed schema snapshot", () => {
    expect(getSchemaMap("coreJsonSchemas")).toMatchSnapshot();
  });
});
