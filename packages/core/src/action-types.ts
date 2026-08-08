import { z } from "zod";

export const ACTION_TYPES = [
  "KEEP",
  "RENAME",
  "CREATE_SHORTCUT",
  "PRESERVE_ARCHIVE",
  "NEEDS_REVIEW",
] as const;

export const ActionTypeSchema = z.enum(ACTION_TYPES).meta({
  id: "ActionType",
  description: "The complete set of version 1 planning actions.",
});

export type ActionType = z.infer<typeof ActionTypeSchema>;

export const RUN_STATES = [
  "Running",
  "Completed",
  "No-op",
  "Blocked",
  "Partial",
  "Failed",
] as const;

export const RunStateSchema = z.enum(RUN_STATES).meta({
  id: "RunState",
  description: "The complete set of execution run states.",
});

export type RunState = z.infer<typeof RunStateSchema>;
