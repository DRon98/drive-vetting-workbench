import type {
  CreateShortcutRequest,
  ProviderError,
  RenameRequest,
} from "@dvw/core";
import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);
const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const PermissionsSchema = z.strictObject({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  deniedReason: NonEmptyStringSchema.optional(),
});

export const LAB_SCENARIOS = [
  "clean",
  "messy-paisano",
  "pagination-gap",
  "protected-archive",
  "shortcut-cycle",
  "stale-after-approval",
  "partial-failure",
] as const;
export type LabScenarioName = (typeof LAB_SCENARIOS)[number];

export const LAB_PROVIDER_METHODS = [
  "listItems",
  "getItem",
  "exportItem",
  "rename",
  "createShortcut",
] as const;
export type LabProviderMethod = (typeof LAB_PROVIDER_METHODS)[number];

export const LabNodeSchema = z.strictObject({
  contentBlob: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  contentFingerprint: NonEmptyStringSchema.nullable(),
  createdTime: IsoDateTimeSchema,
  exportMimeType: NonEmptyStringSchema.nullable(),
  id: NonEmptyStringSchema,
  mimeType: NonEmptyStringSchema,
  modifiedTime: IsoDateTimeSchema,
  name: z.string(),
  parentIds: z.array(NonEmptyStringSchema),
  permissions: PermissionsSchema,
  readDenied: z.boolean(),
  shortcutTargetId: NonEmptyStringSchema.nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  trashed: z.literal(false),
});
export type LabNode = z.infer<typeof LabNodeSchema>;

const ProviderErrorSchema = z.strictObject({
  code: z.enum([
    "DENIED",
    "NOT_FOUND",
    "RATE_LIMITED",
    "STALE_STATE",
    "UNSUPPORTED_EXPORT",
    "PROVIDER_FAILURE",
  ]),
  itemId: NonEmptyStringSchema.nullable(),
  message: NonEmptyStringSchema,
  retryable: z.boolean(),
});

export const LabFaultSchema = z.strictObject({
  error: ProviderErrorSchema,
  method: z.enum(LAB_PROVIDER_METHODS),
  occurrence: z.number().int().positive(),
});
export type LabFault = z.infer<typeof LabFaultSchema>;

export const LabManifestSchema = z
  .strictObject({
    clockStart: IsoDateTimeSchema,
    clockTick: z.number().int().nonnegative(),
    faults: z.array(LabFaultSchema),
    labId: NonEmptyStringSchema,
    nextShortcutSequence: z.number().int().positive(),
    nodes: z.array(LabNodeSchema),
    pageBoundaries: z.array(z.number().int().positive()),
    rootId: NonEmptyStringSchema,
    scenario: z.enum(LAB_SCENARIOS),
    scenarioVersion: NonEmptyStringSchema,
    version: z.literal(1),
  })
  .superRefine((manifest, context) => {
    const ids = manifest.nodes.map((node) => node.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Lab node IDs must be unique.",
      });
    }
    const byId = new Map(manifest.nodes.map((node) => [node.id, node]));
    const root = byId.get(manifest.rootId);
    if (
      root === undefined ||
      root.mimeType !== "application/vnd.google-apps.folder" ||
      root.parentIds.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Lab root must be a parentless folder node.",
      });
    }
    for (const node of manifest.nodes) {
      for (const parentId of node.parentIds) {
        const parent = byId.get(parentId);
        if (
          parent === undefined ||
          parent.mimeType !== "application/vnd.google-apps.folder"
        ) {
          context.addIssue({
            code: "custom",
            message: `Lab parent ${parentId} must be a folder node.`,
          });
        }
      }
      const hasBlob = node.contentBlob !== null;
      const hasFingerprint = node.contentFingerprint !== null;
      const hasExportMimeType = node.exportMimeType !== null;
      const hasSize = node.sizeBytes !== null;
      if (
        hasBlob !== hasFingerprint ||
        hasBlob !== hasExportMimeType ||
        hasBlob !== hasSize
      ) {
        context.addIssue({
          code: "custom",
          message: `Lab content metadata is incomplete for ${node.id}.`,
        });
      }
    }
    for (let index = 1; index < manifest.pageBoundaries.length; index += 1) {
      if (
        (manifest.pageBoundaries[index - 1] ?? 0) >=
        (manifest.pageBoundaries[index] ?? 0)
      ) {
        context.addIssue({
          code: "custom",
          message: "Lab page boundaries must increase.",
        });
      }
    }
  });
export type LabManifest = z.infer<typeof LabManifestSchema>;

const CreateEditSchema = z.strictObject({
  item: z.strictObject({
    content: z.string().optional(),
    exportMimeType: NonEmptyStringSchema.optional(),
    id: NonEmptyStringSchema,
    mimeType: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    parentIds: z.array(NonEmptyStringSchema).min(1),
  }),
  type: z.literal("create"),
});
const RenameEditSchema = z.strictObject({
  itemId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  type: z.literal("rename"),
});
const ReparentEditSchema = z.strictObject({
  itemId: NonEmptyStringSchema,
  parentIds: z.array(NonEmptyStringSchema).min(1),
  type: z.literal("reparent"),
});
const PermissionEditSchema = z.strictObject({
  canRead: z.boolean(),
  canWrite: z.boolean(),
  deniedReason: NonEmptyStringSchema.optional(),
  itemId: NonEmptyStringSchema,
  type: z.literal("permission"),
});
const ContentEditSchema = z.strictObject({
  content: z.string(),
  exportMimeType: NonEmptyStringSchema,
  itemId: NonEmptyStringSchema,
  type: z.literal("content"),
});
const FaultEditSchema = LabFaultSchema.extend({ type: z.literal("fault") });

export const LabEditSchema = z.discriminatedUnion("type", [
  CreateEditSchema,
  RenameEditSchema,
  ReparentEditSchema,
  PermissionEditSchema,
  ContentEditSchema,
  FaultEditSchema,
]);
export type LabEdit = z.infer<typeof LabEditSchema>;

export interface LabSnapshot {
  readonly hash: string;
  readonly manifest: LabManifest;
}

export interface LabDiffEntry {
  readonly itemId: string;
  readonly kind: "ABSENT_FROM_CURRENT" | "ADDED" | "CHANGED";
}

export interface LabTreeEntry {
  readonly depth: number;
  readonly id: string;
  readonly name: string;
  readonly shortcutTargetId: string | null;
}

export interface LabProviderCall {
  readonly method: LabProviderMethod;
  readonly request: unknown;
}

export type LabMutationRequest =
  | { readonly method: "rename"; readonly request: RenameRequest }
  | {
      readonly method: "createShortcut";
      readonly request: CreateShortcutRequest;
    };

export interface ScenarioSeed {
  readonly blobs: Readonly<Record<string, string>>;
  readonly manifest: LabManifest;
}

export type LabProviderFaultError = ProviderError;
