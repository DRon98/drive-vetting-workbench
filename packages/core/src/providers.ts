import { z } from "zod";
import type { ObservedItem } from "./records.js";

export const READ_PROVIDER_METHODS = [
  "listItems",
  "getItem",
  "exportItem",
] as const;

export const MUTATION_PROVIDER_METHODS = ["rename", "createShortcut"] as const;

export const ProviderCapabilitySchema = z.enum(["read", "mutation"]).meta({
  id: "ProviderCapability",
});
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export interface ProviderError {
  readonly code:
    | "DENIED"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "STALE_STATE"
    | "UNSUPPORTED_EXPORT"
    | "PROVIDER_FAILURE";
  readonly itemId: string | null;
  readonly message: string;
  readonly retryable: boolean;
}

export type ProviderResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly error: ProviderError; readonly ok: false };

export interface ListItemsRequest {
  readonly pageSize: number;
  readonly pageToken: string | null;
  readonly rootId: string;
  readonly supportsAllDrives: boolean;
}

export interface ListItemsPage {
  readonly items: readonly ObservedItem[];
  readonly nextPageToken: string | null;
}

export interface ExportItemRequest {
  readonly exportMimeType: string;
  readonly itemId: string;
}

export interface ExportedContent {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface ReadProvider {
  readonly capability: "read";
  exportItem(
    request: ExportItemRequest,
  ): Promise<ProviderResult<ExportedContent>>;
  getItem(itemId: string): Promise<ProviderResult<ObservedItem | null>>;
  listItems(request: ListItemsRequest): Promise<ProviderResult<ListItemsPage>>;
}

export interface RenameRequest {
  readonly expectedModifiedTime: string;
  readonly name: string;
  readonly targetId: string;
}

export interface CreateShortcutRequest {
  readonly name: string;
  readonly parentId: string;
  readonly targetId: string;
}

export interface MutationResult {
  readonly id: string;
  readonly modifiedTime: string;
  readonly name: string;
  readonly parentIds: readonly string[];
  readonly shortcutTargetId: string | null;
}

export interface MutationProvider {
  readonly capability: "mutation";
  createShortcut(
    request: CreateShortcutRequest,
  ): Promise<ProviderResult<MutationResult>>;
  rename(request: RenameRequest): Promise<ProviderResult<MutationResult>>;
}

export function requireReadProvider(provider: ReadProvider): ReadProvider {
  return provider;
}
