# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server that lets Claude Code and other MCP clients connect to and query GCP Cloud SQL PostgreSQL instances. Supports three connection methods: Cloud SQL Connector (recommended), Cloud SQL Auth Proxy, and direct IP.

## Build & Run

```bash
npm install
npm run build          # tsc → dist/
npm run start          # node dist/index.js (stdio transport)
npm run dev            # ts-node src/index.ts
TRANSPORT=http PORT=3000 node dist/index.js  # HTTP mode
```

No test framework is configured — there are no tests yet.

## Architecture

The server exposes 10 MCP tools organized into three groups, each registered via a function in `src/tools/`:

- **`connection.ts`** — `cloudsql_connect`, `cloudsql_disconnect`, `cloudsql_status`. Manages the singleton pg `Pool` in `services/database.ts`. On connect, saves config to `~/.config/gcp-cloudsql-mcp/connection.json` via `services/config.ts` for auto-reconnect on next server start.
- **`query.ts`** — `cloudsql_query`, `cloudsql_list_tables`, `cloudsql_describe_table`, `cloudsql_search_schema`. All read-only, wrapped in `BEGIN READ ONLY` with 30s timeout.
- **`write.ts`** — `cloudsql_execute`, `cloudsql_explain`, `cloudsql_list_indexes`. Write statements require `confirm: true` and have 60s timeout.

**`src/index.ts`** — Entry point. Creates the `McpServer`, registers all tool groups, attempts auto-connect from saved config, then starts either stdio or HTTP transport based on `TRANSPORT` env var.

**`src/services/database.ts`** — Core database layer. Holds the singleton `Pool` and `Connector` (Cloud SQL Node Connector). All query execution flows through `executeQuery()` (read-only) or `executeWrite()`. Also contains schema introspection helpers (`listTables`, `describeTable`) and markdown formatting.

**`src/services/config.ts`** — Persists/loads connection config to `~/.config/gcp-cloudsql-mcp/connection.json` with `0o600` permissions.

## Key Patterns

- Tool input schemas use Zod; all tool schemas are `.strict()` (no extra properties allowed).
- The Cloud SQL Connector path (`instanceConnectionName` provided) handles IAM auth and SSL automatically; the direct path (`host` provided) is a plain pg Pool.
- Results default to markdown table format; most tools also support `format: "json"`.
- Default row limit is 200 (max 1000). Read queries always roll back; writes always commit or rollback on error.
- TypeScript strict mode is **off** (`tsconfig.json: strict: false`).
- Module system is NodeNext (ESM-style imports with `.js` extensions).
