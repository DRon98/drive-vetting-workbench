import { z } from "zod";
import { coreSchemas } from "./records.js";

function exportSchema(schema: (typeof coreSchemas)[keyof typeof coreSchemas]) {
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
}

export const coreJsonSchemas = Object.freeze({
  ApprovedPlan: exportSchema(coreSchemas.ApprovedPlan),
  DecisionRecord: exportSchema(coreSchemas.DecisionRecord),
  EvidenceBundle: exportSchema(coreSchemas.EvidenceBundle),
  ObservedItem: exportSchema(coreSchemas.ObservedItem),
  OperationReceipt: exportSchema(coreSchemas.OperationReceipt),
  PolicyPack: exportSchema(coreSchemas.PolicyPack),
  ProposedAction: exportSchema(coreSchemas.ProposedAction),
  ReviewArtifactManifest: exportSchema(coreSchemas.ReviewArtifactManifest),
  ReviewFeedbackPacket: exportSchema(coreSchemas.ReviewFeedbackPacket),
  RunLedger: exportSchema(coreSchemas.RunLedger),
  ScanCoverage: exportSchema(coreSchemas.ScanCoverage),
  SimulatedDriveManifest: exportSchema(coreSchemas.SimulatedDriveManifest),
});

export const mcpJsonSchemas = Object.freeze({
  DecisionRecord: coreJsonSchemas.DecisionRecord,
  EvidenceBundle: coreJsonSchemas.EvidenceBundle,
  ObservedItem: coreJsonSchemas.ObservedItem,
  OperationReceipt: coreJsonSchemas.OperationReceipt,
  ProposedAction: coreJsonSchemas.ProposedAction,
  RunLedger: coreJsonSchemas.RunLedger,
  ScanCoverage: coreJsonSchemas.ScanCoverage,
});
