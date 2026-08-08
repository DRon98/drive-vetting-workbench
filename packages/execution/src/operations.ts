import type { ObservedItem, ProviderError, ReadProvider } from "@dvw/core";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const PAGE_SIZE = 100;

export interface LiveItemState {
  readonly modifiedTime: string;
  readonly name: string;
  readonly parentIds: readonly string[];
  readonly permissions: {
    readonly canRead: boolean;
    readonly canWrite: boolean;
  };
  readonly shortcutTargetId: string | null;
  readonly trashed: boolean;
}

export type ReadLiveItemResult =
  | { readonly error: null; readonly item: ObservedItem }
  | {
      readonly error: ProviderError | null;
      readonly item: null;
      readonly missing: boolean;
    };

export type ListLiveChildrenResult =
  | { readonly error: null; readonly items: readonly ObservedItem[] }
  | { readonly error: ProviderError; readonly items: null };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareText);
}

export function liveItemState(item: ObservedItem): LiveItemState {
  return {
    modifiedTime: item.modifiedTime,
    name: item.name,
    parentIds: sorted(item.parentIds),
    permissions: {
      canRead: item.permissions.canRead,
      canWrite: item.permissions.canWrite,
    },
    shortcutTargetId: item.shortcutTargetId,
    trashed: item.trashed,
  };
}

export function sameLiveItemState(
  live: ObservedItem,
  expected: LiveItemState,
  options: { readonly allowName?: string } = {},
): boolean {
  const desiredNameSatisfied =
    options.allowName !== undefined && live.name === options.allowName;
  return (
    (desiredNameSatisfied || live.modifiedTime === expected.modifiedTime) &&
    (desiredNameSatisfied || live.name === expected.name) &&
    sorted(live.parentIds).join("\u0000") ===
      sorted(expected.parentIds).join("\u0000") &&
    live.permissions.canRead === expected.permissions.canRead &&
    live.permissions.canWrite === expected.permissions.canWrite &&
    live.shortcutTargetId === expected.shortcutTargetId &&
    live.trashed === expected.trashed
  );
}

export async function readLiveItem(
  provider: ReadProvider,
  itemId: string,
): Promise<ReadLiveItemResult> {
  const result = await provider.getItem(itemId);
  if (!result.ok) return { error: result.error, item: null, missing: false };
  return result.value === null
    ? { error: null, item: null, missing: true }
    : { error: null, item: result.value };
}

export async function listLiveChildren(
  provider: ReadProvider,
  parentId: string,
): Promise<ListLiveChildrenResult> {
  const items: ObservedItem[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;
  do {
    const result = await provider.listItems({
      pageSize: PAGE_SIZE,
      pageToken,
      rootId: parentId,
      supportsAllDrives: true,
    });
    if (!result.ok) return { error: result.error, items: null };
    items.push(...result.value.items);
    const next = result.value.nextPageToken;
    if (next !== null && seenTokens.has(next)) {
      return {
        error: {
          code: "PROVIDER_FAILURE",
          itemId: parentId,
          message: `Provider repeated page token ${next}.`,
          retryable: false,
        },
        items: null,
      };
    }
    if (next !== null) seenTokens.add(next);
    pageToken = next;
  } while (pageToken !== null);
  return { error: null, items };
}

function normalizeName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export function isExactShortcut(
  item: ObservedItem,
  input: {
    readonly name: string;
    readonly parentId: string;
    readonly targetId: string;
  },
): boolean {
  return (
    !item.trashed &&
    item.mimeType === SHORTCUT_MIME_TYPE &&
    item.shortcutTargetId === input.targetId &&
    item.parentIds.includes(input.parentId) &&
    normalizeName(item.name) === normalizeName(input.name)
  );
}

export function hasShortcutConflict(
  item: ObservedItem,
  input: {
    readonly name: string;
    readonly parentId: string;
    readonly targetId: string;
  },
): boolean {
  return (
    !item.trashed &&
    item.parentIds.includes(input.parentId) &&
    (normalizeName(item.name) === normalizeName(input.name) ||
      (item.mimeType === SHORTCUT_MIME_TYPE &&
        item.shortcutTargetId === input.targetId))
  );
}

export function isWritableFolder(item: ObservedItem): boolean {
  return (
    item.mimeType === FOLDER_MIME_TYPE &&
    item.permissions.canRead &&
    item.permissions.canWrite &&
    !item.trashed
  );
}
