import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  executeQuery,
  listTables,
  describeTable,
  formatResultAsMarkdown,
} from "../services/database.js";

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    "cloudsql_query",
    {
      title: "Execute SQL Query",
      description: `Execute a read-only SQL SELECT query against the connected Cloud SQL PostgreSQL database.

All queries run inside a READ ONLY transaction with a 30-second statement timeout. Results are capped at max_rows (default 200).

Args:
  - query (string): SQL SELECT statement to execute
  - params (array, optional): Parameterized query values ($1, $2, ...) to prevent SQL injection
  - max_rows (number, optional): Maximum rows to return (default: 200, max: 1000)
  - format (string, optional): Output format - 'markdown' (default) or 'json'

Returns: Query results in the requested format with row count and truncation notice if applicable.

Examples:
  - Basic: query="SELECT * FROM users LIMIT 10"
  - Parameterized: query="SELECT * FROM orders WHERE status=$1 AND created_at > $2", params=["pending", "2024-01-01"]
  - JSON output: query="SELECT count(*), status FROM orders GROUP BY status", format="json"

Error handling:
  - "No active database connection" → Run cloudsql_connect first
  - "statement timeout" → Query exceeded 30s limit, add filters or LIMIT clause
  - "permission denied" → Database user lacks SELECT on that table`,
      inputSchema: z.object({
        query: z.string().min(1).describe("SQL SELECT query"),
        params: z.array(z.unknown()).optional().describe("Parameterized values ($1, $2, ...)"),
        max_rows: z.number().int().min(1).max(1000).default(200).describe("Max rows to return"),
        format: z.enum(["markdown", "json"]).default("markdown").describe("Output format"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const result = await executeQuery({
          query: params.query,
          params: params.params as unknown[] | undefined,
          maxRows: params.max_rows,
        });

        if (params.format === "json") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                rows: result.rows,
                rowCount: result.rowCount,
                truncated: result.truncated,
                fields: result.fields,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{ type: "text", text: formatResultAsMarkdown(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `❌ Query error: ${msg}` }] };
      }
    }
  );

  server.registerTool(
    "cloudsql_list_tables",
    {
      title: "List Database Tables",
      description: `List all tables and views in the connected PostgreSQL database.

Args:
  - schema (string, optional): Filter by schema name (default: all user schemas)
  - format (string, optional): Output format - 'markdown' (default) or 'json'

Returns: Table name, schema, type (BASE TABLE / VIEW), and estimated row count.`,
      inputSchema: z.object({
        schema: z.string().optional().describe("Filter by schema (e.g., 'public')"),
        format: z.enum(["markdown", "json"]).default("markdown"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const tables = await listTables(params.schema);

        if (params.format === "json") {
          return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
        }

        if (tables.length === 0) {
          return { content: [{ type: "text", text: "_No tables found._" }] };
        }

        const rows = tables.map((t) =>
          `| ${t.schema} | ${t.name} | ${t.type} | ${t.rowEstimate?.toLocaleString() ?? "—"} |`
        );
        const md = [
          `| Schema | Table | Type | ~Rows |`,
          `| --- | --- | --- | --- |`,
          ...rows,
          `\n_${tables.length} object(s) found._`,
        ].join("\n");

        return { content: [{ type: "text", text: md }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `❌ Error: ${msg}` }] };
      }
    }
  );

  server.registerTool(
    "cloudsql_describe_table",
    {
      title: "Describe Table Schema",
      description: `Show column definitions, types, nullability, defaults, and primary key info for a table.

Args:
  - table (string): Table name to describe
  - schema (string, optional): Schema name (default: 'public')
  - format (string, optional): Output format - 'markdown' (default) or 'json'

Returns: Column list with type, nullable, default value, and primary key indicator.`,
      inputSchema: z.object({
        table: z.string().min(1).describe("Table name"),
        schema: z.string().default("public").describe("Schema name (default: public)"),
        format: z.enum(["markdown", "json"]).default("markdown"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const cols = await describeTable(params.table, params.schema);

        if (params.format === "json") {
          return { content: [{ type: "text", text: JSON.stringify(cols, null, 2) }] };
        }

        if (cols.length === 0) {
          return {
            content: [{
              type: "text",
              text: `Table "${params.schema}.${params.table}" not found or has no columns.`,
            }],
          };
        }

        const rows = cols.map((c) =>
          `| ${c.isPrimaryKey ? "🔑 " : ""}${c.column} | ${c.type} | ${c.nullable ? "YES" : "NO"} | ${c.default ?? "—"} |`
        );
        const md = [
          `**${params.schema}.${params.table}**`,
          `| Column | Type | Nullable | Default |`,
          `| --- | --- | --- | --- |`,
          ...rows,
        ].join("\n");

        return { content: [{ type: "text", text: md }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `❌ Error: ${msg}` }] };
      }
    }
  );

  server.registerTool(
    "cloudsql_search_schema",
    {
      title: "Search Schema Objects",
      description: `Search for tables, columns, or indexes by name pattern across the database.

Args:
  - pattern (string): Search pattern (case-insensitive, supports % wildcards)
  - search_type (string, optional): 'tables', 'columns', or 'all' (default: 'all')
  - schema (string, optional): Limit search to a schema

Returns: Matching tables and/or columns with their schema context.`,
      inputSchema: z.object({
        pattern: z.string().min(1).describe("Search pattern (e.g., 'user%', '%id%')"),
        search_type: z.enum(["tables", "columns", "all"]).default("all"),
        schema: z.string().optional().describe("Limit to a specific schema"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const results: string[] = [];
        const schemaFilter = params.schema ? "AND table_schema = $2" : "";
        const schemaParam = params.schema ? [params.pattern, params.schema] : [params.pattern];

        if (params.search_type === "tables" || params.search_type === "all") {
          const tableResult = await executeQuery({
            query: `
              SELECT table_schema, table_name, table_type
              FROM information_schema.tables
              WHERE table_name ILIKE $1
                AND table_schema NOT IN ('pg_catalog', 'information_schema')
                ${schemaFilter}
              ORDER BY table_schema, table_name
              LIMIT 50
            `,
            params: schemaParam,
          });

          if (tableResult.rows.length > 0) {
            results.push("**Tables/Views:**");
            tableResult.rows.forEach((r) => {
              results.push(`- \`${r.table_schema}.${r.table_name}\` (${r.table_type})`);
            });
          }
        }

        if (params.search_type === "columns" || params.search_type === "all") {
          const colResult = await executeQuery({
            query: `
              SELECT table_schema, table_name, column_name, udt_name
              FROM information_schema.columns
              WHERE column_name ILIKE $1
                AND table_schema NOT IN ('pg_catalog', 'information_schema')
                ${schemaFilter}
              ORDER BY table_schema, table_name, column_name
              LIMIT 100
            `,
            params: schemaParam,
          });

          if (colResult.rows.length > 0) {
            results.push("\n**Columns:**");
            colResult.rows.forEach((r) => {
              results.push(`- \`${r.table_schema}.${r.table_name}.${r.column_name}\` (${r.udt_name})`);
            });
          }
        }

        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.join("\n")
              : `No schema objects matching \`${params.pattern}\` found.`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `❌ Error: ${msg}` }] };
      }
    }
  );
}
