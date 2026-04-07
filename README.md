# GCP Cloud SQL MCP Server

An MCP server for Claude Code (and other MCP clients) to connect to and query GCP Cloud SQL PostgreSQL instances — including customer environments.

## Tools

| Tool | Description |
|------|-------------|
| `cloudsql_connect` | Establish a connection (Connector / Auth Proxy / direct) |
| `cloudsql_disconnect` | Close the connection |
| `cloudsql_status` | Check connection and server info |
| `cloudsql_query` | Execute read-only SELECT queries |
| `cloudsql_list_tables` | List tables and views |
| `cloudsql_describe_table` | Show column definitions |
| `cloudsql_search_schema` | Search tables/columns by name pattern |
| `cloudsql_execute` | Execute write statements (INSERT/UPDATE/DELETE/DDL) |
| `cloudsql_explain` | Run EXPLAIN on a query |
| `cloudsql_list_indexes` | Show table indexes |

## Connection Methods

### 1. Cloud SQL Connector (recommended)

Uses the [Cloud SQL Node Connector](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector) — handles IAM auth and SSL automatically. Requires Application Default Credentials.

```bash
gcloud auth application-default login
# or set GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
```

Connect in Claude:
```
cloudsql_connect:
  instance_connection_name: "myproject:europe-west1:my-instance"
  database: "mydb"
  user: "myuser"
  password: "secret"
  ip_type: "PSC"  # PUBLIC, PRIVATE, or PSC (default: PSC)
```

### 2. IAM Database Authentication (passwordless)

```
cloudsql_connect:
  instance_connection_name: "myproject:europe-west1:my-instance"
  database: "mydb"
  user: "sa@myproject.iam"   # service account email
  use_iam_auth: true
```

The DB user must be created in PostgreSQL as:
```sql
CREATE USER "sa@myproject.iam" WITH LOGIN;
GRANT CONNECT ON DATABASE mydb TO "sa@myproject.iam";
```

### 3. Cloud SQL Auth Proxy

Run the proxy locally:
```bash
cloud-sql-proxy myproject:europe-west1:my-instance --port 5432
```

Then connect:
```
cloudsql_connect:
  host: "127.0.0.1"
  port: 5432
  database: "mydb"
  user: "myuser"
  password: "secret"
```

## Installation

### Build

```bash
npm install
npm run build
```

### Add to Claude Code

```bash
claude mcp add gcp-cloudsql -- node /path/to/gcp-cloudsql-mcp-server/dist/index.js
```

Or edit `~/.claude/claude.json` manually:

```json
{
  "mcpServers": {
    "gcp-cloudsql": {
      "command": "node",
      "args": ["/path/to/gcp-cloudsql-mcp-server/dist/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/sa-key.json"
      }
    }
  }
}
```

### Add to Cursor

Open Cursor Settings > MCP and add a new server, or edit `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "gcp-cloudsql": {
      "command": "node",
      "args": ["/path/to/gcp-cloudsql-mcp-server/dist/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/sa-key.json"
      }
    }
  }
}
```

### HTTP mode (for remote/shared access)

```bash
TRANSPORT=http PORT=3000 node dist/index.js
```

Add to Claude Code:
```json
{
  "mcpServers": {
    "gcp-cloudsql": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Security Notes

- **Read-only queries** run inside `BEGIN READ ONLY` transactions — cannot modify data.
- **Write statements** (`cloudsql_execute`) require `confirm: true` as an explicit gate.
- Statement timeout is **30s** for reads, **60s** for writes.
- Results are **capped at 200 rows** by default (configurable up to 1000).
- Use **parameterized queries** (`$1, $2, ...`) to prevent SQL injection.

## Multi-environment usage

For switching between customer environments, simply call `cloudsql_connect` again with new parameters — it will close the previous connection automatically.

## IAM Roles Required

The service account / user needs:
- `roles/cloudsql.client` (to connect via Cloud SQL Connector)
- Database-level permissions granted via SQL (`GRANT SELECT ON ALL TABLES...`)
