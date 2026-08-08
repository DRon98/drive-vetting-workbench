import { describe, expect, test } from "vitest";
import type { ObservedItem, ReadProvider } from "@dvw/core";
import { createTextContentExtractor } from "./index.js";

const item: ObservedItem = {
  contentFingerprint: "sha256:unicode",
  createdTime: "2026-08-07T12:00:00.000Z",
  id: "unicode-item",
  mimeType: "text/plain",
  modifiedTime: "2026-08-07T12:00:00.000Z",
  name: "Unicode text",
  parentIds: ["root"],
  permissions: { canRead: true, canWrite: false },
  scanGeneration: "provider-observed",
  shortcutTargetId: null,
  trashed: false,
};

function providerWithText(text: string): ReadProvider {
  return {
    capability: "read",
    exportItem() {
      return Promise.resolve({
        ok: true,
        value: {
          bytes: new TextEncoder().encode(text),
          mimeType: "text/plain",
        },
      } as const);
    },
    getItem() {
      return Promise.resolve({ ok: true, value: item } as const);
    },
    listItems() {
      return Promise.resolve({
        ok: true,
        value: { items: [item], nextPageToken: null },
      } as const);
    },
  };
}

describe("text content extraction", () => {
  test("limits snippets by UTF-8 bytes without splitting a character", async () => {
    const extractor = createTextContentExtractor({ maxSnippetBytes: 5 });

    const result = await extractor.extract(providerWithText("A😀B"), item);

    expect(result).toMatchObject({
      kind: "extracted",
      sizeBytes: 6,
      snippet: "A😀",
    });
    if (result.kind === "extracted") {
      expect(
        new TextEncoder().encode(result.snippet).byteLength,
      ).toBeLessThanOrEqual(5);
    }
  });
});
