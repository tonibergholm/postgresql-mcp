import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { initializePool, closePool, getPool, IpType } from "../services/database.js";

export function registerConnectionTools(server: McpServer): void {
  server.registerTool(
    "cloudsql_connect",
    {
      title: "Connect to Cloud SQL PostgreSQL",
      description: `Establish a connection to a GCP Cloud SQL PostgreSQL instance.

Supports three connection methods:
1. **Cloud SQL Connector** (recommended): Provide \`instance_connection_name\` in format \`PROJECT:REGION:INSTANCE\`. Handles IAM auth and SSL automatically. Requires Application Default Credentials (ADC) or a service account key.
2. **Cloud SQL Auth Proxy**: Run \`cloud-sql-proxy PROJECT:REGION:INSTANCE\` locally, then connect via \`host=127.0.0.1\`.
3. **Direct IP** (private IP / VPC): Provide \`host\` directly.

For IAM database authentication (passwordless), set \`use_iam_auth=true\` and ensure the DB user matches the IAM identity email (without the domain for service accounts).

Args:
  - instance_connection_name (string, optional): Cloud SQL instance name: PROJECT:REGION:INSTANCE
  - host (string, optional): Direct host IP or hostname (used when not using connector)
  - port (number, optional): TCP port (default: 5432)
  - database (string): PostgreSQL database name
  - user (string): Database user
  - password (string, optional): Password (omit when using IAM auth)
  - use_iam_auth (boolean, optional): Use IAM database authentication (default: false)
  - ip_type (string, optional): IP type for Cloud SQL Connector: PUBLIC, PRIVATE, or PSC (default: PSC)
  - ssl (boolean, optional): Enable SSL for direct connections (default: false)

Returns: Connection status message.

Examples:
  - Cloud SQL Connector: instance_connection_name="myproject:europe-west1:my-instance", database="mydb", user="myuser"
  - IAM auth: instance_connection_name="myproject:europe-west1:my-instance", database="mydb", user="service-account@project.iam", use_iam_auth=true
  - Auth Proxy: host="127.0.0.1", database="mydb", user="myuser", password="secret"`,
      inputSchema: z.object({
        instance_connection_name: z.string()
          .regex(/^[^:]+:[^:]+:[^:]+$/, "Must be in format PROJECT:REGION:INSTANCE")
          .optional()
          .describe("Cloud SQL instance connection name: PROJECT:REGION:INSTANCE"),
        host: z.string().optional().describe("Direct host (for Auth Proxy or private IP)"),
        port: z.number().int().min(1).max(65535).default(5432).describe("TCP port"),
        database: z.string().min(1).describe("PostgreSQL database name"),
        user: z.string().min(1).describe("Database user"),
        password: z.string().optional().describe("Password (omit for IAM auth)"),
        use_iam_auth: z.boolean().default(false).describe("Use IAM database authentication"),
        ip_type: z.enum(["PUBLIC", "PRIVATE", "PSC"]).default("PSC").describe("IP type for Cloud SQL Connector: PUBLIC, PRIVATE, or PSC (default: PSC)"),
        ssl: z.boolean().default(false).describe("Enable SSL for direct connections"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      if (!params.instance_connection_name && !params.host) {
        return {
          content: [{
            type: "text",
            text: "Error: Provide either instance_connection_name (Cloud SQL Connector) or host (direct/proxy connection).",
          }],
        };
      }

      try {
        await initializePool({
          instanceConnectionName: params.instance_connection_name,
          host: params.host,
          port: params.port,
          database: params.database,
          user: params.user,
          password: params.password,
          useIAMAuth: params.use_iam_auth,
          ipType: params.ip_type as IpType,
          ssl: params.ssl,
        });

        const method = params.instance_connection_name
          ? `Cloud SQL Connector (${params.ip_type}) → ${params.instance_connection_name}`
          : `Direct → ${params.host}:${params.port}`;

        return {
          content: [{
            type: "text",
            text: `✅ Connected to PostgreSQL database "${params.database}" as "${params.user}"\nMethod: ${method}${params.use_iam_auth ? " (IAM auth)" : ""}`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: `❌ Connection failed: ${msg}\n\nTroubleshooting:\n- Check that ADC is configured (run: gcloud auth application-default login)\n- Verify the instance connection name format: PROJECT:REGION:INSTANCE\n- Ensure the database user exists and has login privileges\n- For IAM auth, ensure the service account has 'Cloud SQL Client' IAM role`,
          }],
        };
      }
    }
  );

  server.registerTool(
    "cloudsql_disconnect",
    {
      title: "Disconnect from Cloud SQL",
      description: "Close the active Cloud SQL database connection and release resources.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      await closePool();
      return { content: [{ type: "text", text: "✅ Disconnected from database." }] };
    }
  );

  server.registerTool(
    "cloudsql_status",
    {
      title: "Check Connection Status",
      description: "Check if there is an active database connection and show server version info.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const p = getPool();
        const client = await p.connect();
        const result = await client.query("SELECT version(), current_database(), current_user, inet_server_addr(), pg_postmaster_start_time()");
        client.release();
        const row = result.rows[0];
        return {
          content: [{
            type: "text",
            text: `✅ Connected\nDatabase: ${row.current_database}\nUser: ${row.current_user}\nServer: ${row.inet_server_addr ?? "localhost"}\nPostgreSQL: ${row.version}\nStarted: ${row.pg_postmaster_start_time}`,
          }],
        };
      } catch {
        return { content: [{ type: "text", text: "❌ No active connection. Use cloudsql_connect first." }] };
      }
    }
  );
}
