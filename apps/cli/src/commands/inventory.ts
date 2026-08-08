import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import { createQueryService } from "@dvw/query-service";
import {
  CliUsageError,
  option,
  type ParsedCliArguments,
} from "../io/arguments.js";
import type { CliCommandOutput, CliRuntime } from "../io/contracts.js";

export function runInventoryCommand(
  args: ParsedCliArguments,
  runtime: CliRuntime,
): CliCommandOutput {
  const store = new EvidenceStore(runtime.databasePath);
  try {
    store.migrate();
    const coverage = store.getActiveCoverage();
    if (coverage === null)
      throw new CliUsageError("Run scan before inventory.");
    const service = createQueryService({ store });
    const summary = service.inventorySummary({ limit: 100 });
    const query = option(args, "query") ?? null;
    const items =
      query === null ? [] : service.searchItems({ limit: 100, query }).items;
    return {
      command: "inventory",
      data: {
        deniedItemCount: summary.deniedItemCount,
        itemCount: summary.itemCount,
        items: items.map((item) => ({
          canRead: item.permissions.canRead,
          canWrite: item.permissions.canWrite,
          id: item.id,
          mimeType: item.mimeType,
          name: item.name,
          parentIds: [...item.parentIds],
          shortcutTargetId: item.shortcutTargetId,
          trashed: item.trashed,
        })),
        mode: query === null ? "summary" : "search",
        query,
        rootId: summary.rootId,
        shortcutCount: summary.shortcutCount,
        warningCount: summary.warningCount,
      },
      policyVersion: runtime.policyVersion,
      scanGeneration: coverage.generationId,
      status: "SUCCESS",
    };
  } finally {
    store.close();
  }
}
