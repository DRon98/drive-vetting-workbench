import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import { scanFolder } from "@dvw/scanner";
import {
  CliUsageError,
  option,
  type ParsedCliArguments,
} from "../io/arguments.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";

function pageSize(value: string | undefined): number {
  if (value === undefined) return 100;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new CliUsageError(
      "--page-size must be an integer from 1 through 1000.",
    );
  }
  return parsed;
}

export async function runScanCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<CliCommandOutput> {
  const rootId = option(args, "root");
  if (rootId === undefined) throw new CliUsageError("Scan requires --root.");
  const providerId = option(args, "provider") ?? runtime.defaultProviderId;
  const selected = await runtime.providers.select({ providerId });
  const scanGeneration = runtime.generationId(rootId);
  const store = new EvidenceStore(runtime.databasePath);
  try {
    store.migrate();
    const result = await scanFolder({
      extractContent: false,
      generationId: scanGeneration,
      maxShortcutDepth: 16,
      pageSize: pageSize(option(args, "page-size")),
      provider: selected.read,
      rootId,
      startedAt: runtime.now(),
      store,
    });
    const coverageGap =
      result.issues.length > 0 ||
      result.coverage.deniedItems.length > 0 ||
      result.coverage.unsupportedTypes.length > 0 ||
      result.coverage.warnings.length > 0;
    return {
      command: "scan",
      data: {
        deniedItemCount: result.coverage.deniedItems.length,
        issueCount: result.issues.length,
        itemCount: result.itemCount,
        pageCount: result.pageCount,
        providerId: selected.providerId,
        published: true,
        rootId,
        unsupportedTypeCount: result.coverage.unsupportedTypes.length,
        warningCount: result.coverage.warnings.length,
      },
      policyVersion: runtime.policyVersion,
      scanGeneration,
      status: coverageGap ? "COVERAGE_GAP" : "SUCCESS",
    };
  } finally {
    store.close();
  }
}
