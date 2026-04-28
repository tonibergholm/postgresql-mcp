import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { initializePool, closePool, getPool, IpType, type ConnectionConfig } from "../services/database.js";
import { saveConnectionConfig, CONFIG_FILE } from "../services/config.js";
import { startTunnel, stopTunnel, isTunnelRunning } from "../services/tunnel.js";
import { getEnvironment, listEnvironments, getEnvironmentDetails } from "../services/environments.js";

// "server does not support SSL connections" surfaces during the IAP-tunnel
// readiness window: SSH `-L` opens the local listener before the channel can
// forward bytes, so the postgres SSL probe lands somewhere that replies 'N'.
// Match the message text rather than a stable error code — pg surfaces this
// as a plain Error.
function isTunnelHandshakeRace(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /server does not support SSL connections/i.test(msg)
    || /ECONNRESET/.test(msg)
    || /Connection terminated unexpectedly/i.test(msg);
}

async function initializePoolWithRetry(
  config: ConnectionConfig,
  maxAttempts: number,
  delayMs: number,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initializePool(config);
      if (attempt > 1) {
        console.error(`[connect] Tunnel handshake succeeded on attempt ${attempt}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isTunnelHandshakeRace(err)) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[connect] Tunnel handshake race (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export function registerConnectionTools(server: McpServer): void {
  server.registerTool(
    "cloudsql_connect",
    {
      title: "Connect to Cloud SQL PostgreSQL",
      description: `Establish a connection to a GCP Cloud SQL PostgreSQL instance.

**Easiest: use a named environment** — provide just \`environment\` (e.g. "my-env"). This automatically starts an IAP tunnel (if configured) and connects with pre-configured credentials. Use \`cloudsql_list_environments\` to see available environments.

Manual connection methods:
1. **Cloud SQL Connector** (recommended): Provide \`instance_connection_name\` in format \`PROJECT:REGION:INSTANCE\`.
2. **Cloud SQL Auth Proxy**: Run \`cloud-sql-proxy\` locally, then connect via \`host=127.0.0.1\`.
3. **Direct IP**: Provide \`host\` directly.

Args:
  - environment (string, optional): Named environment from environments.json (e.g. "my-env")
  - instance_connection_name (string, optional): Cloud SQL instance name: PROJECT:REGION:INSTANCE
  - host (string, optional): Direct host IP or hostname
  - port (number, optional): TCP port (default: 5432)
  - database (string, optional): PostgreSQL database name (required if not using environment)
  - user (string, optional): Database user (required if not using environment)
  - password (string, optional): Password
  - use_iam_auth (boolean, optional): Use IAM database authentication (default: false)
  - ip_type (string, optional): IP type for Cloud SQL Connector: PUBLIC, PRIVATE, or PSC (default: PSC)
  - ssl (boolean, optional): Enable SSL for direct connections (default: false)

Examples:
  - Environment: environment="my-env"
  - Cloud SQL Connector: instance_connection_name="myproject:europe-west1:my-instance", database="mydb", user="myuser"
  - Auth Proxy: host="127.0.0.1", database="mydb", user="myuser", password="secret"`,
      inputSchema: z.object({
        environment: z.string().optional().describe("Named environment from environments.json (e.g. 'my-env')"),
        instance_connection_name: z.string()
          .regex(/^[^:]+:[^:]+:[^:]+$/, "Must be in format PROJECT:REGION:INSTANCE")
          .optional()
          .describe("Cloud SQL instance connection name: PROJECT:REGION:INSTANCE"),
        host: z.string().optional().describe("Direct host (for Auth Proxy or private IP)"),
        port: z.number().int().min(1).max(65535).default(5432).describe("TCP port"),
        database: z.string().optional().describe("PostgreSQL database name"),
        user: z.string().optional().describe("Database user"),
        password: z.string().optional().describe("Password (omit for IAM auth)"),
        use_iam_auth: z.boolean().default(false).describe("Use IAM database authentication"),
        ip_type: z.enum(["PUBLIC", "PRIVATE", "PSC"]).default("PSC").describe("IP type for Cloud SQL Connector"),
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
      let database = params.database;
      let user = params.user;
      let password = params.password;
      let host = params.host;
      let port = params.port;
      let ssl = params.ssl;
      let tunnelStarted = false;
      let envName: string | undefined;

      // Resolve environment if provided
      if (params.environment) {
        const env = getEnvironment(params.environment);
        if (!env) {
          const available = listEnvironments();
          return {
            content: [{
              type: "text",
              text: `❌ Unknown environment "${params.environment}".\n\nAvailable environments: ${available.length > 0 ? available.join(", ") : "(none — add environments to environments.json)"}`,
            }],
          };
        }

        envName = params.environment;
        // Environment provides defaults; top-level params override
        database = params.database ?? env.connection.database;
        user = params.user ?? env.connection.user;
        password = params.password ?? env.connection.password;
        ssl = params.ssl || (env.connection.ssl ?? false);
        host = params.host ?? env.connection.host ?? "localhost";
        port = params.port !== 5432 ? params.port : (env.connection.port ?? env.tunnel?.localPort ?? 5432);

        // Start IAP tunnel if configured
        if (env.tunnel) {
          try {
            await startTunnel(env.tunnel);
            tunnelStarted = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{
                type: "text",
                text: `❌ Failed to start IAP tunnel for "${params.environment}": ${msg}\n\nYou can start the tunnel manually:\ngcloud compute ssh --tunnel-through-iap --project=${env.tunnel.project} --zone=${env.tunnel.zone} ${env.tunnel.bastion} -- -N -L ${env.tunnel.localPort}:${env.tunnel.remoteHost}:${env.tunnel.remotePort}`,
              }],
            };
          }
        }
      }

      if (!database || !user) {
        return {
          content: [{
            type: "text",
            text: "Error: Provide database and user (or use an environment name).",
          }],
        };
      }

      if (!params.environment && !params.instance_connection_name && !params.host) {
        return {
          content: [{
            type: "text",
            text: "Error: Provide either environment, instance_connection_name, or host.",
          }],
        };
      }

      try {
        const config = {
          instanceConnectionName: params.instance_connection_name,
          host: host || undefined,
          port,
          database,
          user,
          password,
          useIAMAuth: params.use_iam_auth,
          ipType: params.ip_type as IpType,
          ssl,
        };
        // When the IAP tunnel was just started, the local TCP port is up
        // before the SSH channel is fully forwarding. The first postgres
        // handshake can land on a half-ready channel and surface as
        // "server does not support SSL connections" (server replies 'N'
        // because the bytes never reach postgres). Retry briefly.
        if (tunnelStarted) {
          await initializePoolWithRetry(config, 3, 750);
        } else {
          await initializePool(config);
        }
        saveConnectionConfig(config);

        let method: string;
        if (envName) {
          method = `Environment "${envName}"${tunnelStarted ? " (IAP tunnel auto-started)" : ""}`;
        } else if (params.instance_connection_name) {
          method = `Cloud SQL Connector (${params.ip_type}) → ${params.instance_connection_name}`;
        } else {
          method = `Direct → ${host}:${port}`;
        }

        return {
          content: [{
            type: "text",
            text: `Connected to PostgreSQL database "${database}" as "${user}"\nMethod: ${method}${params.use_iam_auth ? " (IAM auth)" : ""}\nConnection saved to ${CONFIG_FILE}`,
          }],
        };
      } catch (err) {
        // If we started a tunnel for this attempt, clean it up
        if (tunnelStarted) await stopTunnel();
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
      description: "Close the active Cloud SQL database connection, IAP tunnel (if any), and release resources.",
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
      await stopTunnel();
      return { content: [{ type: "text", text: "Disconnected from database and stopped tunnel." }] };
    }
  );

  server.registerTool(
    "cloudsql_list_environments",
    {
      title: "List Available Environments",
      description: "List pre-configured database environments from environments.json. Each environment bundles connection credentials and optional IAP tunnel config.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const details = getEnvironmentDetails();
      const names = Object.keys(details);
      if (names.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No environments configured. Add environments to environments.json in the repo root or ~/.config/gcp-cloudsql-mcp/environments.json",
          }],
        };
      }

      const lines = names.map((name) => {
        const d = details[name];
        return `- **${name}**: database=${d.database}, tunnel=${d.hasTunnel ? "yes (auto IAP)" : "no"}`;
      });

      return {
        content: [{
          type: "text",
          text: `Available environments:\n${lines.join("\n")}\n\nConnect with: cloudsql_connect({ environment: "<name>" })`,
        }],
      };
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
