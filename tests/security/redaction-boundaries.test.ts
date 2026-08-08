import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservedItem, ReadProvider } from "@dvw/core";
import { createTextContentExtractor } from "@dvw/content-extractor";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import { providerExecutionFailure } from "@dvw/execution";
import { scanFolder } from "@dvw/scanner";
import { describe, expect, test } from "vitest";
import { redactSensitiveText } from "../../packages/security/src/index.js";

const observed: ObservedItem = {
  contentFingerprint: null,
  createdTime: "2026-08-08T12:00:00.000Z",
  id: "synthetic-item",
  mimeType: "text/plain",
  modifiedTime: "2026-08-08T12:00:00.000Z",
  name: "Synthetic item",
  parentIds: ["synthetic-root"],
  permissions: { canRead: true, canWrite: false },
  scanGeneration: "security-generation",
  shortcutTargetId: null,
  trashed: false,
};

function sensitiveMessage(): {
  readonly message: string;
  readonly secret: string;
} {
  const secret = `ya29.${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4"}`;
  return {
    message: `Provider failed with access_token=${secret}\nInjected log line`,
    secret,
  };
}

describe("error, gap, event, and receipt redaction", () => {
  test("normalizes and redacts credential-shaped text without echoing its value", () => {
    const { message, secret } = sensitiveMessage();
    const redacted = redactSensitiveText(message);

    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("access_token=");
    expect(redacted).not.toContain("\n");
    expect(redacted).toContain("[REDACTED]");
  });

  test("does not retain a provider secret in execution failures", () => {
    const { message, secret } = sensitiveMessage();
    const failure = providerExecutionFailure({
      code: "PROVIDER_FAILURE",
      itemId: "synthetic-item",
      message,
      retryable: false,
    });

    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(failure.message).toContain("[REDACTED]");
    expect(failure.providerError?.message).toContain("[REDACTED]");
  });

  test("does not store a provider secret as a content-extraction gap", async () => {
    const { message, secret } = sensitiveMessage();
    const provider: ReadProvider = {
      capability: "read",
      exportItem: () =>
        Promise.resolve({
          error: {
            code: "PROVIDER_FAILURE",
            itemId: observed.id,
            message,
            retryable: false,
          },
          ok: false,
        }),
      getItem: () => Promise.resolve({ ok: true, value: observed }),
      listItems: () =>
        Promise.resolve({
          ok: true,
          value: { items: [observed], nextPageToken: null },
        }),
    };
    const result = await createTextContentExtractor({
      maxSnippetBytes: 128,
    }).extract(provider, observed);

    expect(JSON.stringify(result)).not.toContain(secret);
    if (result.kind !== "gap") {
      throw new Error("The synthetic provider failure must produce a gap.");
    }
    expect(result.detail).toContain("[REDACTED]");
  });

  test("does not retain a provider secret in scan errors or failed-generation evidence", async () => {
    const { message, secret } = sensitiveMessage();
    const provider: ReadProvider = {
      capability: "read",
      exportItem: () => Promise.reject(new Error("Unexpected export.")),
      getItem: () => Promise.reject(new Error("Unexpected get.")),
      listItems: () =>
        Promise.resolve({
          error: {
            code: "PROVIDER_FAILURE",
            itemId: "synthetic-root",
            message,
            retryable: false,
          },
          ok: false,
        }),
    };
    const root = mkdtempSync(join(tmpdir(), "dvw-security-scan-redaction-"));
    const store = new EvidenceStore(join(root, "evidence.sqlite"));
    store.migrate();
    let failure: unknown;
    try {
      await scanFolder({
        extractContent: false,
        generationId: "security-failed-generation",
        maxShortcutDepth: 4,
        pageSize: 10,
        provider,
        rootId: "synthetic-root",
        startedAt: "2026-08-08T12:00:00.000Z",
        store,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).message).toContain("[REDACTED]");
    expect(
      JSON.stringify(store.listGenerationIssues("security-failed-generation")),
    ).not.toContain(secret);
    store.close();
  });
});
