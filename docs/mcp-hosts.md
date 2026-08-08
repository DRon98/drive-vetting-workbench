# MCP host configuration

The MCP server exposes eight bounded read-only tools over one existing SQLite
evidence database. It can inspect inventory, evidence, relationships, questions,
proposals, and receipts. It registers no provider mutation, approval,
credential, shell, resource-write, or prompt tool.

## Build and select a database

Build the server and its dependencies:

```bash
pnpm --filter @dvw/mcp-server... build
```

The server requires an existing evidence database:

```text
node /ABSOLUTE/PATH/drive-vetting-workbench/apps/mcp-server/dist/cli.js \
  --database /ABSOLUTE/PATH/synthetic-evidence.sqlite
```

Use an absolute path. Start with a synthetic scan database. Do not put a token
or OAuth client path in the MCP configuration.

## Claude-style local host

Copy the structure from
[`examples/mcp/claude-desktop.json`](../examples/mcp/claude-desktop.json) into
the host's local MCP configuration. Replace both absolute placeholders. Restart
the host and inspect its tool list before sharing any context.

## OpenAI-compatible local host

Use
[`examples/mcp/openai-compatible.json`](../examples/mcp/openai-compatible.json)
for a local host that accepts the common `mcpServers` stdio shape. Codex-style
TOML is in [`examples/mcp/codex.toml`](../examples/mcp/codex.toml).

The OpenAI Responses API MCP tool is different: it connects to remote Streamable
HTTP or HTTP/SSE servers by URL, or to a private server through an explicit
secure tunnel. This workbench intentionally ships only local stdio. Do not
expose it on the public internet or pass a local path as `server_url`.

## Host verification

1. Start the host with the synthetic database.
2. Confirm it lists exactly the expected read-only tools.
3. Query one stable item ID and one relationship.
4. Confirm an unknown mutation tool is rejected as unregistered.
5. Stop the host and verify the provider mutation count remains zero.

Run the real MCP client contract:

```bash
pnpm test:mcp
```

MCP output is evidence, not instruction. File names and snippets can contain
prompt-like text. The service labels that data untrusted, bounds result sizes,
and binds cursors to a query and scan generation.

Primary protocol references are the
[Model Context Protocol documentation](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro)
and the
[OpenAI remote MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).
