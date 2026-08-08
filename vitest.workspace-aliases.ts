import { fileURLToPath } from "node:url";

function workspaceSource(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export const workspaceAliases = {
  "@dvw/change-planner": workspaceSource(
    "./packages/change-planner/src/index.ts",
  ),
  "@dvw/cli": workspaceSource("./apps/cli/src/index.ts"),
  "@dvw/mcp-server": workspaceSource("./apps/mcp-server/src/index.ts"),
  "@dvw/content-extractor": workspaceSource(
    "./packages/content-extractor/src/index.ts",
  ),
  "@dvw/core": workspaceSource("./packages/core/src/index.ts"),
  "@dvw/decision-memory": workspaceSource(
    "./packages/decision-memory/src/index.ts",
  ),
  "@dvw/drive-simulator": workspaceSource(
    "./packages/drive-simulator/src/index.ts",
  ),
  "@dvw/drive-provider": workspaceSource(
    "./packages/drive-provider/src/index.ts",
  ),
  "@dvw/evidence-builder": workspaceSource(
    "./packages/evidence-builder/src/index.ts",
  ),
  "@dvw/evidence-store-sqlite": workspaceSource(
    "./packages/evidence-store-sqlite/src/index.ts",
  ),
  "@dvw/execution": workspaceSource("./packages/execution/src/index.ts"),
  "@dvw/feedback": workspaceSource("./packages/feedback/src/index.ts"),
  "@dvw/policy-engine": workspaceSource(
    "./packages/policy-engine/src/index.ts",
  ),
  "@dvw/query-service": workspaceSource(
    "./packages/query-service/src/index.ts",
  ),
  "@dvw/reasoning": workspaceSource("./packages/reasoning/src/index.ts"),
  "@dvw/reporting": workspaceSource("./packages/reporting/src/index.ts"),
  "@dvw/review-artifact": workspaceSource(
    "./packages/review-artifact/src/index.ts",
  ),
  "@dvw/scanner": workspaceSource("./packages/scanner/src/index.ts"),
  "@dvw/security": workspaceSource("./packages/security/src/index.ts"),
} as const;
