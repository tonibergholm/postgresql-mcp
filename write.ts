import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeWrite, executeQuery } from "../services/database.js";

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "cloudsql_execute",
    {
      title: "Execute Write SQL Statement",
      description: `Execute a data-modifying SQL statement (INSERT, UPDATE, DELETE, DDL) on the connected database.

⚠️ This tool commits changes. Use with caution in production environments.

The statement runs inside a transaction with a 60-second timeout. If an error occurs, the transaction is rolled back automatically.

Args:
  - statement (string): SQL statement to execute (INSERT / UPDATE / DELETE / CREATE / ALTER / DROP)
  - params (array, optional): Parameterized values ($1, $2, ...) — always use these instead of string interpolation
  - confirm (boolean): Must be true to execute. Acts as a confirmation gate.

Returns: Number of affected rows and returned data (if using RETURNING clause).

Examples:
  - Insert: statement="INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id", params=["Alice", "alice@example.com"], confirm=true
  - Update: statement="UPDATE orders SET status=$1 WHERE id=$2", params=["shipped", 42], confirm=true
  - Delete: statement="DELETE FROM sessions WHERE expires_at < NOW()", confirm=true`,
      inputSchema: z.object({
        statement: z.string().min(1).describe("SQL write statement"),
        params: z.array(z.unknown()).optional().describe("Parameterized values"),
        confirm: z.boolean().describe("Must be true to execute — acts as confirmation gate"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      if (!params.confirm) {
        return {
          content: [{
            type: "text",
            text: "⚠️ Execution blocked: set confirm=true to execute this write statement.",
          }],
        };
      }

      try {
        const result = await executeWrite(params.statement, params.params as unknown[] | undefined);

        const summary = result.rowCount !== null
          ? `✅ Statement executed. ${result.rowCount} row(s) affected.`
          : "✅ Statement executed.";

        if (result.rows.length > 0) {
          const cols = result.fields.map((f) => f.name);
          const header = `| ${cols.join(" | ")} |`;
          const divider = `| ${cols.map(() => "---").join(" | ")} |`;
          const rows = result.rows.map(
            (row) => `| ${cols.map((c) => String(row[c] ?? "NULL")).join(" | ")} |`
          );
          return {
            content: [{
              type: "text",
              text: `${summary}\n\n**Returned rows:**\n${[header, divider, ...rows].join("\n")}`,
            }],
          };
        }

        return { content: [{ type: "text", text: summary }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `❌ Statement failed (rolled back): ${msg}` }] };
      }
    }
  );

  server.registerTool(
    "cloudsql_explain",
    {
      title: "Explain Query Plan",
      description: `Run EXPLAIN (ANALYZE, BUFFERS) on a query to show the execution plan and performance details.

Useful for identifying slow queries, missing indexes, and inefficient joins.

Args:
  - query (string): SQL query to analyze
  - params (array, optional): Parameterized values ($1, $2, ...)
  - analyze (boolean, optional): Run EXPLAIN ANALYZE (actually executes query) vs just EXPLAIN (default: false)

Returns: PostgreSQL query plan as text.`,
      inputSchema: z.object({
        query: z.string().min(1).describe("SQL query to explain"),
        params: z.array(z.unknown()).optional().describe("Parameterized values"),
        analyze: z.boolean().default(false).describe("Run EXPLAIN ANALYZE (executes the query)"),
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
        const prefix = params.analyze
          ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)"
          : "EXPLAIN (FORMAT TEXT)";
        const result = await executeQuery({
          query: `${prefix} ${params.query}`,
          params: params.params as unknown[] | undefined,
          maxRows: 200,
        });

        const planLines = result.rows.map((r) => Object.values(r)[0] as string).join("\n");
        return { content: [{ type: "text", text: `\`\`\`\n${planLines}\n\`\`\`` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `❌ EXPLAIN failed: ${msg}` }] };
      }
    }
  );

  server.registerTool(
    "cloudsql_list_indexes",
    {
      title: "List Table Indexes",
      description: `Show indexes defined on a table, including columns, uniqueness, and index type.

Args:
  - table (string): Table name
  - schema (string, optional): Schema name (default: 'public')

Returns: Index list with columns, type, and uniqueness.`,
      inputSchema: z.object({
        table: z.string().min(1).describe("Table name"),
        schema: z.string().default("public").describe("Schema name"),
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
          query: `
            SELECT
              i.relname AS index_name,
              ix.indisunique AS is_unique,
              ix.indisprimary AS is_primary,
              am.amname AS index_type,
              array_to_string(
                array_agg(a.attname ORDER BY x.n),
                ', '
              ) AS columns
            FROM
              pg_class t
              JOIN pg_namespace n ON n.oid = t.relnamespace
              JOIN pg_index ix ON t.oid = ix.indrelid
              JOIN pg_class i ON i.oid = ix.indexrelid
              JOIN pg_am am ON am.oid = i.relam
              CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
            WHERE
              t.relname = $1
              AND n.nspname = $2
            GROUP BY i.relname, ix.indisunique, ix.indisprimary, am.amname
            ORDER BY ix.indisprimary DESC, i.relname
          `,
          params: [params.table, params.schema],
        });

        if (result.rows.length === 0) {
          return { content: [{ type: "text", text: `No indexes found for "${params.schema}.${params.table}".` }] };
        }

        const rows = result.rows.map((r) =>
          `| ${r.index_name} | ${r.columns} | ${r.index_type} | ${r.is_primary ? "PK" : r.is_unique ? "UNIQUE" : "—"} |`
        );
        const md = [
          `**Indexes on ${params.schema}.${params.table}:**`,
          `| Index Name | Columns | Type | Constraint |`,
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
}
