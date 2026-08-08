#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import { createQueryService } from "@dvw/query-service";
import { createDriveVettingMcpServer } from "./index.js";

function databasePath(arguments_: readonly string[]): string {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--database" ||
    arguments_[1] === undefined ||
    arguments_[1].trim().length === 0
  ) {
    throw new Error("Usage: dvw-mcp --database <existing-evidence.sqlite>");
  }
  const path = resolve(arguments_[1]);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error("The evidence database must be an existing regular file.");
  }
  return path;
}

try {
  const store = new EvidenceStore(databasePath(process.argv.slice(2)));
  const query = createQueryService({ store });
  const handle = serveStdio(() => createDriveVettingMcpServer(query), {
    onerror(error) {
      console.error(error.message);
    },
  });

  const shutdown = (): void => {
    void handle.close().finally(() => {
      store.close();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : "MCP startup failed.");
  process.exitCode = 1;
}
