import type {
  ExportedContent,
  ListItemsPage,
  ObservedItem,
  ProviderResult,
  ReadProvider,
} from "@dvw/core";

// This skeleton is intentionally read-only. Map one storage API to the shared
// records and typed errors. Add contract tests before selecting it at runtime.
export class ExampleReadProvider implements ReadProvider {
  public readonly capability = "read" as const;

  public exportItem(): Promise<ProviderResult<ExportedContent>> {
    return Promise.resolve({
      error: {
        code: "UNSUPPORTED_EXPORT",
        itemId: null,
        message: "The example provider does not export content.",
        retryable: false,
      },
      ok: false,
    });
  }

  public getItem(): Promise<ProviderResult<ObservedItem | null>> {
    return Promise.resolve({ ok: true, value: null });
  }

  public listItems(): Promise<ProviderResult<ListItemsPage>> {
    return Promise.resolve({
      ok: true,
      value: { items: [], nextPageToken: null },
    });
  }
}
