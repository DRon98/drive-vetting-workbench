import type { ObservedItem, ReadProvider, ScanCoverage } from "@dvw/core";
import type {
  ContentExtractionIssueCode,
  ContentExtractor,
} from "@dvw/content-extractor";
import type {
  EvidenceStore,
  IndexedItemInput,
  ScanIssue,
} from "@dvw/evidence-store-sqlite";
import { redactSensitiveText } from "@dvw/security";

export type ScanPipelineIssueCode =
  | ContentExtractionIssueCode
  | "BROKEN_SHORTCUT"
  | "DENIED_ITEM"
  | "SHORTCUT_CYCLE"
  | "SHORTCUT_DEPTH_EXCEEDED"
  | "SHORTCUT_TARGET_DENIED"
  | "UNSUPPORTED_TYPE";

export interface ScanPipelineIssue extends ScanIssue {
  readonly code: ScanPipelineIssueCode;
}

export interface ScanFolderOptions {
  readonly extractContent: boolean;
  readonly extractor?: ContentExtractor;
  readonly generationId: string;
  readonly maxShortcutDepth: number;
  readonly pageSize: number;
  readonly provider: ReadProvider;
  readonly rootId: string;
  readonly startedAt: string;
  readonly store: EvidenceStore;
}

export interface ScanFolderResult {
  readonly coverage: ScanCoverage;
  readonly extractedItemCount: number;
  readonly issues: readonly ScanPipelineIssue[];
  readonly itemCount: number;
  readonly pageCount: number;
  readonly published: true;
}

export class ScanPipelineError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(redactSensitiveText(message), options);
    this.name = "ScanPipelineError";
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ScanPipelineError(
      "INVALID_SCAN_OPTIONS",
      `${field} must be a positive integer.`,
    );
  }
}

function issue(
  code: ScanPipelineIssueCode,
  detail: string,
  itemId: string | null,
): ScanPipelineIssue {
  return { code, detail: redactSensitiveText(detail), itemId };
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(
    error instanceof Error ? error.message : "Unknown scan failure.",
  );
}

async function listAllItems(
  provider: ReadProvider,
  rootId: string,
  pageSize: number,
): Promise<{
  items: ObservedItem[];
  pageCount: number;
  pageTokensConsumed: string[];
}> {
  const items: ObservedItem[] = [];
  const itemIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  const pageTokensConsumed: string[] = [];
  let pageCount = 0;
  let pageToken: string | null = null;

  do {
    if (pageToken !== null) {
      if (seenPageTokens.has(pageToken)) {
        throw new ScanPipelineError(
          "REPEATED_PAGE_TOKEN",
          `Provider repeated page token ${pageToken}.`,
        );
      }
      seenPageTokens.add(pageToken);
      pageTokensConsumed.push(pageToken);
    }
    const page = await provider.listItems({
      pageSize,
      pageToken,
      rootId,
      supportsAllDrives: true,
    });
    if (!page.ok) {
      throw new ScanPipelineError(
        "PROVIDER_LIST_FAILED",
        `${page.error.code}: ${page.error.message}`,
      );
    }
    pageCount += 1;
    for (const observed of page.value.items) {
      if (itemIds.has(observed.id)) {
        throw new ScanPipelineError(
          "DUPLICATE_ITEM_ID",
          `Provider returned item ${observed.id} more than once.`,
        );
      }
      itemIds.add(observed.id);
      items.push(observed);
    }
    pageToken = page.value.nextPageToken;
  } while (pageToken !== null);

  return { items, pageCount, pageTokensConsumed };
}

async function resolveShortcutIssues(
  provider: ReadProvider,
  scopedItems: ReadonlyMap<string, ObservedItem>,
  maxDepth: number,
): Promise<ScanPipelineIssue[]> {
  const issues: ScanPipelineIssue[] = [];
  const externalItems = new Map<string, ObservedItem | null>();
  const reportedCycles = new Set<string>();

  const getTarget = async (
    targetId: string,
  ): Promise<
    | { readonly item: ObservedItem | null; readonly kind: "item" }
    | { readonly issue: ScanPipelineIssue; readonly kind: "issue" }
  > => {
    const scoped = scopedItems.get(targetId);
    if (scoped !== undefined) {
      return { item: scoped, kind: "item" };
    }
    if (externalItems.has(targetId)) {
      return { item: externalItems.get(targetId) ?? null, kind: "item" };
    }
    const result = await provider.getItem(targetId);
    if (!result.ok) {
      if (result.error.code === "DENIED") {
        return {
          issue: issue(
            "SHORTCUT_TARGET_DENIED",
            result.error.message,
            targetId,
          ),
          kind: "issue",
        };
      }
      return { item: null, kind: "item" };
    }
    externalItems.set(targetId, result.value);
    return { item: result.value, kind: "item" };
  };

  for (const source of scopedItems.values()) {
    if (source.shortcutTargetId === null) {
      continue;
    }
    const visited = new Set([source.id]);
    let targetId: string | null = source.shortcutTargetId;
    let depth = 0;

    while (targetId !== null) {
      if (visited.has(targetId)) {
        const signature = [...visited].sort().join("|");
        if (!reportedCycles.has(signature)) {
          reportedCycles.add(signature);
          issues.push(
            issue(
              "SHORTCUT_CYCLE",
              `Shortcut cycle detected through ${[...visited].join(" -> ")}.`,
              source.id,
            ),
          );
        }
        break;
      }
      if (depth >= maxDepth) {
        issues.push(
          issue(
            "SHORTCUT_DEPTH_EXCEEDED",
            `Shortcut traversal exceeded depth ${maxDepth}.`,
            source.id,
          ),
        );
        break;
      }
      visited.add(targetId);
      depth += 1;

      const lookup = await getTarget(targetId);
      if (lookup.kind === "issue") {
        issues.push(lookup.issue);
        break;
      }
      const target = lookup.item;
      if (target === null) {
        issues.push(
          issue(
            "BROKEN_SHORTCUT",
            `Shortcut target ${targetId} does not exist or cannot be fetched.`,
            source.id,
          ),
        );
        break;
      }
      targetId = target.shortcutTargetId;
    }
  }

  return issues;
}

export async function scanFolder(
  options: ScanFolderOptions,
): Promise<ScanFolderResult> {
  assertPositiveInteger(options.pageSize, "pageSize");
  assertPositiveInteger(options.maxShortcutDepth, "maxShortcutDepth");
  if (options.extractContent && options.extractor === undefined) {
    throw new ScanPipelineError(
      "INVALID_SCAN_OPTIONS",
      "Content extraction requires an extractor.",
    );
  }

  let generationStarted = false;
  try {
    options.store.beginGeneration({
      generationId: options.generationId,
      rootId: options.rootId,
      startedAt: options.startedAt,
    });
    generationStarted = true;

    const enumeration = await listAllItems(
      options.provider,
      options.rootId,
      options.pageSize,
    );
    const scopedItems = new Map(
      enumeration.items.map((observed) => [observed.id, observed]),
    );
    const issues: ScanPipelineIssue[] = [];
    let exportsAttempted = 0;
    let extractedItemCount = 0;

    for (const providerObserved of enumeration.items) {
      const observed: ObservedItem = {
        ...providerObserved,
        parentIds: [...providerObserved.parentIds],
        permissions: { ...providerObserved.permissions },
        scanGeneration: options.generationId,
      };
      let extraction: Pick<
        IndexedItemInput,
        "contentLocator" | "extractedSnippet" | "sizeBytes"
      > = {
        contentLocator: null,
        extractedSnippet: null,
        sizeBytes: null,
      };

      if (!observed.permissions.canRead) {
        issues.push(
          issue(
            "DENIED_ITEM",
            observed.permissions.deniedReason ?? "Item read is denied.",
            observed.id,
          ),
        );
      } else if (options.extractContent && options.extractor !== undefined) {
        const result = await options.extractor.extract(
          options.provider,
          observed,
        );
        if (result.attempted) {
          exportsAttempted += 1;
        }
        if (result.kind === "extracted") {
          extractedItemCount += 1;
          extraction = {
            contentLocator: result.contentLocator,
            extractedSnippet: result.snippet,
            sizeBytes: result.sizeBytes,
          };
        } else if (result.kind === "gap") {
          issues.push(issue(result.code, result.detail, observed.id));
        }
      }

      options.store.stageItem({ ...observed, ...extraction });
    }

    issues.push(
      ...(await resolveShortcutIssues(
        options.provider,
        scopedItems,
        options.maxShortcutDepth,
      )),
    );

    const coverage: ScanCoverage = {
      deniedItems: issues
        .filter((entry) => entry.code === "DENIED_ITEM")
        .map((entry) => ({
          itemId: entry.itemId ?? options.rootId,
          reason: entry.detail,
        })),
      exportsAttempted,
      generationId: options.generationId,
      itemCount: enumeration.items.length,
      pageTokensConsumed: enumeration.pageTokensConsumed,
      rootId: options.rootId,
      state: "Complete",
      unsupportedTypes: issues
        .filter((entry) => entry.code === "UNSUPPORTED_TYPE")
        .map((entry) => ({
          itemId: entry.itemId ?? options.rootId,
          mimeType: scopedItems.get(entry.itemId ?? "")?.mimeType ?? "unknown",
        })),
      warnings: issues
        .filter(
          (entry) =>
            entry.code !== "DENIED_ITEM" && entry.code !== "UNSUPPORTED_TYPE",
        )
        .map((entry) => `${entry.code}: ${entry.detail}`),
    };
    options.store.recordCoverage(coverage);
    for (const scanIssue of issues) {
      if (
        scanIssue.code !== "DENIED_ITEM" &&
        scanIssue.code !== "UNSUPPORTED_TYPE"
      ) {
        options.store.recordIssue(options.generationId, scanIssue);
      }
    }
    options.store.publishGeneration(options.generationId);

    return {
      coverage,
      extractedItemCount,
      issues,
      itemCount: enumeration.items.length,
      pageCount: enumeration.pageCount,
      published: true,
    };
  } catch (error) {
    if (
      generationStarted &&
      options.store.getGeneration(options.generationId)?.state === "Staging"
    ) {
      options.store.failGeneration(options.generationId, {
        code: error instanceof ScanPipelineError ? error.code : "SCAN_FAILED",
        detail: errorMessage(error),
        itemId: options.rootId,
      });
    }
    if (error instanceof ScanPipelineError) {
      throw error;
    }
    throw new ScanPipelineError("SCAN_FAILED", errorMessage(error), {
      cause: new Error(errorMessage(error)),
    });
  }
}
