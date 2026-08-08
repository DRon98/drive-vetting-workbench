import { createHash } from "node:crypto";
import {
  LAB_SCENARIOS,
  LabManifestSchema,
  type LabManifest,
  type LabNode,
  type LabScenarioName,
  type ScenarioSeed,
} from "./types.js";

const clockStart = "2026-08-08T12:00:00.000Z";
const folderMimeType = "application/vnd.google-apps.folder";
const shortcutMimeType = "application/vnd.google-apps.shortcut";

function content(text: string): {
  blob: string;
  fingerprint: string;
  text: string;
} {
  const blob = createHash("sha256").update(text).digest("hex");
  return { blob, fingerprint: `sha256:${blob}`, text };
}

function node(input: {
  content?: string;
  exportMimeType?: string;
  id: string;
  mimeType: string;
  name: string;
  parentIds: readonly string[];
  permissions?: LabNode["permissions"];
  readDenied?: boolean;
  shortcutTargetId?: string | null;
}): { blobs: Record<string, string>; node: LabNode } {
  const body = input.content === undefined ? null : content(input.content);
  return {
    blobs: body === null ? {} : { [body.blob]: body.text },
    node: {
      contentBlob: body?.blob ?? null,
      contentFingerprint: body?.fingerprint ?? null,
      createdTime: clockStart,
      exportMimeType:
        body === null ? null : (input.exportMimeType ?? "text/plain"),
      id: input.id,
      mimeType: input.mimeType,
      modifiedTime: clockStart,
      name: input.name,
      parentIds: [...input.parentIds],
      permissions: input.permissions ?? { canRead: true, canWrite: true },
      readDenied: input.readDenied ?? false,
      shortcutTargetId: input.shortcutTargetId ?? null,
      sizeBytes: body === null ? null : Buffer.byteLength(body.text),
      trashed: false,
    },
  };
}

function seed(
  scenario: LabScenarioName,
  rootId: string,
  entries: readonly ReturnType<typeof node>[],
  input: Partial<Pick<LabManifest, "faults" | "pageBoundaries">> = {},
): ScenarioSeed {
  const manifest = LabManifestSchema.parse({
    clockStart,
    clockTick: 0,
    faults: input.faults ?? [],
    labId: `lab-${scenario}`,
    nextShortcutSequence: 1,
    nodes: entries.map((entry) => entry.node),
    pageBoundaries: input.pageBoundaries ?? [2, 4],
    rootId,
    scenario,
    scenarioVersion: "1.0.0",
    version: 1,
  });
  return {
    blobs: entries.reduce<Record<string, string>>(
      (all, entry) => ({ ...all, ...entry.blobs }),
      {},
    ),
    manifest,
  };
}

function clean(): ScenarioSeed {
  const rootId = "clean-root";
  return seed("clean", rootId, [
    node({
      id: rootId,
      mimeType: folderMimeType,
      name: "Clean",
      parentIds: [],
    }),
    node({
      content: "Synthetic compliant invoice.",
      id: "clean-invoice",
      mimeType: "application/pdf",
      name: "2026-08-01 — Clean Deal — Invoice.pdf",
      parentIds: [rootId],
    }),
  ]);
}

function messyPaisano(): ScenarioSeed {
  const rootId = "messy-root";
  return seed("messy-paisano", rootId, [
    node({
      id: rootId,
      mimeType: folderMimeType,
      name: "Messy Paisano",
      parentIds: [],
    }),
    node({
      id: "messy-communications",
      mimeType: folderMimeType,
      name: "Communications",
      parentIds: [rootId],
    }),
    node({
      content: "Synthetic invoice dated 2026-08-01.",
      id: "messy-invoice-draft",
      mimeType: "application/pdf",
      name: "Hotel Paisano Invoice draft FINAL.pdf",
      parentIds: [rootId],
    }),
    node({
      content: "Synthetic board memo.",
      id: "messy-board-memo",
      mimeType: "application/pdf",
      name: "Board Memo.pdf",
      parentIds: [rootId],
    }),
    node({
      id: "messy-existing-shortcut",
      mimeType: shortcutMimeType,
      name: "Board Memo shortcut",
      parentIds: ["messy-communications"],
      shortcutTargetId: "messy-board-memo",
    }),
  ]);
}

function paginationGap(): ScenarioSeed {
  const rootId = "pagination-root";
  const entries = [
    node({
      id: rootId,
      mimeType: folderMimeType,
      name: "Pagination Gap",
      parentIds: [],
    }),
    ...Array.from({ length: 6 }, (_, index) =>
      node({
        id: `pagination-item-${index + 1}`,
        mimeType: "application/pdf",
        name: `Page Item ${index + 1}.pdf`,
        parentIds: [rootId],
        ...(index === 5
          ? {
              permissions: {
                canRead: false,
                canWrite: false,
                deniedReason: "Synthetic final-page denial",
              },
              readDenied: true,
            }
          : {}),
      }),
    ),
  ];
  return seed("pagination-gap", rootId, entries, {
    pageBoundaries: [1, 3, 5],
  });
}

function protectedArchive(): ScenarioSeed {
  const rootId = "protected-root";
  return seed("protected-archive", rootId, [
    node({
      id: rootId,
      mimeType: folderMimeType,
      name: "Protected",
      parentIds: [],
    }),
    node({
      id: "protected-archive-folder",
      mimeType: folderMimeType,
      name: "Archive 2025",
      parentIds: [rootId],
    }),
    node({
      content: "Synthetic signed original.",
      id: "protected-legal-original",
      mimeType: "application/pdf",
      name: "Signed Original.pdf",
      parentIds: ["protected-archive-folder"],
      permissions: { canRead: true, canWrite: false },
    }),
  ]);
}

function shortcutCycle(): ScenarioSeed {
  const rootId = "cycle-root";
  return seed("shortcut-cycle", rootId, [
    node({
      id: rootId,
      mimeType: folderMimeType,
      name: "Cycle",
      parentIds: [],
    }),
    node({
      id: "cycle-a",
      mimeType: shortcutMimeType,
      name: "Cycle A",
      parentIds: [rootId],
      shortcutTargetId: "cycle-b",
    }),
    node({
      id: "cycle-b",
      mimeType: shortcutMimeType,
      name: "Cycle B",
      parentIds: [rootId],
      shortcutTargetId: "cycle-a",
    }),
  ]);
}

function staleAfterApproval(): ScenarioSeed {
  const rootId = "stale-root";
  return seed("stale-after-approval", rootId, [
    node({
      id: rootId,
      mimeType: folderMimeType,
      name: "Stale",
      parentIds: [],
    }),
    node({
      content: "Synthetic stale-state target.",
      id: "stale-target",
      mimeType: "application/pdf",
      name: "Approved Name Draft.pdf",
      parentIds: [rootId],
    }),
  ]);
}

function partialFailure(): ScenarioSeed {
  const rootId = "partial-root";
  return seed(
    "partial-failure",
    rootId,
    [
      node({
        id: rootId,
        mimeType: folderMimeType,
        name: "Partial",
        parentIds: [],
      }),
      node({
        id: "partial-one",
        mimeType: "application/pdf",
        name: "One.pdf",
        parentIds: [rootId],
      }),
      node({
        id: "partial-two",
        mimeType: "application/pdf",
        name: "Two.pdf",
        parentIds: [rootId],
      }),
    ],
    {
      faults: [
        {
          error: {
            code: "PROVIDER_FAILURE",
            itemId: "partial-two",
            message: "Synthetic second rename failure.",
            retryable: true,
          },
          method: "rename",
          occurrence: 2,
        },
      ],
    },
  );
}

const builders: Record<LabScenarioName, () => ScenarioSeed> = {
  clean,
  "messy-paisano": messyPaisano,
  "pagination-gap": paginationGap,
  "partial-failure": partialFailure,
  "protected-archive": protectedArchive,
  "shortcut-cycle": shortcutCycle,
  "stale-after-approval": staleAfterApproval,
};

export function scenarioSeed(name: string): ScenarioSeed {
  if (!LAB_SCENARIOS.includes(name as LabScenarioName)) {
    throw new RangeError(`Unknown Drive Lab scenario: ${name}`);
  }
  return builders[name as LabScenarioName]();
}
