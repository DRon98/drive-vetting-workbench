import type { ObservedItem, ProviderError, ReadProvider } from "@dvw/core";
import { redactSensitiveText } from "@dvw/security";

export type ContentExtractionIssueCode =
  "DENIED_ITEM" | "EXPORT_FAILED" | "INVALID_TEXT" | "UNSUPPORTED_TYPE";

export type ContentExtractionResult =
  | {
      readonly attempted: true;
      readonly contentLocator: string;
      readonly kind: "extracted";
      readonly sizeBytes: number;
      readonly snippet: string;
    }
  | {
      readonly attempted: boolean;
      readonly code: ContentExtractionIssueCode;
      readonly detail: string;
      readonly kind: "gap";
    }
  | {
      readonly attempted: false;
      readonly kind: "skipped";
    };

export interface ContentExtractor {
  extract(
    provider: ReadProvider,
    item: ObservedItem,
  ): Promise<ContentExtractionResult>;
}

export interface TextContentExtractorOptions {
  readonly maxSnippetBytes: number;
}

const GOOGLE_NATIVE_TEXT_TYPES = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.spreadsheet",
]);

const NON_CONTENT_TYPES = new Set([
  "application/vnd.google-apps.folder",
  "application/vnd.google-apps.shortcut",
]);

function issueCodeForProviderFailure(
  code: ProviderError["code"],
): ContentExtractionIssueCode {
  if (code === "DENIED") {
    return "DENIED_ITEM";
  }
  if (code === "UNSUPPORTED_EXPORT") {
    return "UNSUPPORTED_TYPE";
  }
  return "EXPORT_FAILED";
}

function utf8Prefix(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const characters: string[] = [];
  let byteLength = 0;

  for (const character of text) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteLength + characterBytes > maxBytes) {
      break;
    }
    characters.push(character);
    byteLength += characterBytes;
  }

  return characters.join("");
}

export function createTextContentExtractor(
  options: TextContentExtractorOptions,
): ContentExtractor {
  if (
    !Number.isSafeInteger(options.maxSnippetBytes) ||
    options.maxSnippetBytes < 1
  ) {
    throw new RangeError("maxSnippetBytes must be a positive integer.");
  }

  return {
    async extract(provider, item) {
      if (!item.permissions.canRead) {
        return {
          attempted: false,
          code: "DENIED_ITEM",
          detail: redactSensitiveText(
            item.permissions.deniedReason ?? "Item content cannot be read.",
          ),
          kind: "gap",
        };
      }
      if (NON_CONTENT_TYPES.has(item.mimeType)) {
        return { attempted: false, kind: "skipped" };
      }
      if (
        item.mimeType !== "text/plain" &&
        !GOOGLE_NATIVE_TEXT_TYPES.has(item.mimeType)
      ) {
        return {
          attempted: false,
          code: "UNSUPPORTED_TYPE",
          detail: redactSensitiveText(
            `No text extractor supports ${item.mimeType}.`,
          ),
          kind: "gap",
        };
      }

      const exported = await provider.exportItem({
        exportMimeType: "text/plain",
        itemId: item.id,
      });
      if (!exported.ok) {
        return {
          attempted: true,
          code: issueCodeForProviderFailure(exported.error.code),
          detail: redactSensitiveText(exported.error.message),
          kind: "gap",
        };
      }

      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          exported.value.bytes,
        );
      } catch {
        return {
          attempted: true,
          code: "INVALID_TEXT",
          detail: "Exported content is not valid UTF-8 text.",
          kind: "gap",
        };
      }

      return {
        attempted: true,
        contentLocator: `provider:${item.id}#export:text/plain`,
        kind: "extracted",
        sizeBytes: exported.value.bytes.byteLength,
        snippet: utf8Prefix(text, options.maxSnippetBytes),
      };
    },
  };
}
