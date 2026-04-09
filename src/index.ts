import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { registerConnectionTools } from "./tools/connection.js";
import { registerQueryTools } from "./tools/query.js";
import { registerWriteTools } from "./tools/write.js";
import { closePool, initializePool } from "./services/database.js";
import { loadConnectionConfig } from "./services/config.js";

const server = new McpServer({
  name: "gcp-cloudsql-mcp-server",
  version: "1.0.0",
});

registerConnectionTools(server);
registerQueryTools(server);
registerWriteTools(server);

async function autoConnectFromSavedConfig(): Promise<void> {
  const saved = loadConnectionConfig();
  if (!saved) return;
  try {
    await initializePool(saved);
    const target = saved.instanceConnectionName ?? `${saved.host}:${saved.port ?? 5432}`;
    console.error(`[auto-connect] Restored connection to "${saved.database}" (${target})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auto-connect] Could not restore saved connection: ${msg}`);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closePool();
  process.exit(0);
});

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GCP Cloud SQL MCP server running on stdio");
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "gcp-cloudsql-mcp-server" });
  });

  const port = parseInt(process.env.PORT ?? "3000");
  app.listen(port, () => {
    console.error(`GCP Cloud SQL MCP server running on http://localhost:${port}/mcp`);
  });
}

const transport = process.env.TRANSPORT ?? "stdio";

autoConnectFromSavedConfig().then(() => {
  if (transport === "http") {
    runHTTP().catch((err) => {
      console.error("Server error:", err);
      process.exit(1);
    });
  } else {
    runStdio().catch((err) => {
      console.error("Server error:", err);
      process.exit(1);
    });
  }
});
