import { Pool, PoolClient, QueryResult } from "pg";
import { Connector, IpAddressTypes, AuthTypes } from "@google-cloud/cloud-sql-connector";

export interface ConnectionConfig {
  instanceConnectionName?: string; // projects/PROJECT/locations/REGION/instances/INSTANCE
  host?: string;                   // Direct host (fallback / Cloud SQL Auth Proxy)
  port?: number;
  database: string;
  user: string;
  password?: string;
  useIAMAuth?: boolean;            // Use IAM DB authentication (no password needed)
  ssl?: boolean;
}

export interface QueryOptions {
  query: string;
  params?: unknown[];
  maxRows?: number;
}

export interface QueryResultData {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
  truncated: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: string;
  rowEstimate?: number;
}

export interface ColumnInfo {
  column: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
}

const DEFAULT_MAX_ROWS = 200;

let pool: Pool | null = null;
let connector: Connector | null = null;

export async function initializePool(config: ConnectionConfig): Promise<void> {
  await closePool();

  if (config.instanceConnectionName) {
    // Use Cloud SQL Connector (recommended - handles IAM auth + SSL automatically)
    connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: config.instanceConnectionName,
      ipType: IpAddressTypes.PUBLIC,
      ...(config.useIAMAuth ? { authType: AuthTypes.IAM } : {}),
    });

    pool = new Pool({
      ...clientOpts,
      database: config.database,
      user: config.user,
      ...(config.password ? { password: config.password } : {}),
      max: 5,
    });
  } else {
    // Direct connection (Cloud SQL Auth Proxy or private IP)
    pool = new Pool({
      host: config.host || "127.0.0.1",
      port: config.port || 5432,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: 5,
    });
  }

  // Verify connection
  const client = await pool.connect();
  client.release();
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (connector) {
    await connector.close();
    connector = null;
  }
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error("No active database connection. Use cloudsql_connect first.");
  }
  return pool;
}

export async function executeQuery(options: QueryOptions): Promise<QueryResultData> {
  const client: PoolClient = await getPool().connect();
  try {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

    // Safety: wrap in transaction with statement timeout and row limit
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '30s'`);

    const result: QueryResult = await client.query({
      text: options.query,
      values: options.params,
    });

    await client.query("ROLLBACK");

    const truncated = result.rows.length > maxRows;
    return {
      rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      truncated,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function executeWrite(query: string, params?: unknown[]): Promise<QueryResultData> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = '60s'`);

    const result: QueryResult = await client.query({ text: query, values: params });
    await client.query("COMMIT");

    return {
      rows: result.rows,
      rowCount: result.rowCount ?? 0,
      fields: result.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) ?? [],
      truncated: false,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listTables(schema?: string): Promise<TableInfo[]> {
  const result = await executeQuery({
    query: `
      SELECT
        t.table_schema AS schema,
        t.table_name AS name,
        t.table_type AS type,
        s.n_live_tup AS row_estimate
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s
        ON s.schemaname = t.table_schema AND s.relname = t.table_name
      WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
        ${schema ? "AND t.table_schema = $1" : ""}
      ORDER BY t.table_schema, t.table_type, t.table_name
    `,
    params: schema ? [schema] : [],
    maxRows: 500,
  });

  return result.rows.map((r) => ({
    schema: String(r.schema),
    name: String(r.name),
    type: String(r.type),
    rowEstimate: r.row_estimate != null ? Number(r.row_estimate) : undefined,
  }));
}

export async function describeTable(tableName: string, schema = "public"): Promise<ColumnInfo[]> {
  const result = await executeQuery({
    query: `
      SELECT
        c.column_name AS column,
        c.udt_name AS type,
        (c.is_nullable = 'YES') AS nullable,
        c.column_default AS default_val,
        EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = c.table_schema
            AND tc.table_name = c.table_name
            AND ccu.column_name = c.column_name
        ) AS is_pk
      FROM information_schema.columns c
      WHERE c.table_schema = $1
        AND c.table_name = $2
      ORDER BY c.ordinal_position
    `,
    params: [schema, tableName],
    maxRows: 200,
  });

  return result.rows.map((r) => ({
    column: String(r.column),
    type: String(r.type),
    nullable: Boolean(r.nullable),
    default: r.default_val != null ? String(r.default_val) : null,
    isPrimaryKey: Boolean(r.is_pk),
  }));
}

export function formatResultAsMarkdown(result: QueryResultData): string {
  if (result.rows.length === 0) return "_No rows returned._";

  const cols = result.fields.map((f) => f.name);
  const header = `| ${cols.join(" | ")} |`;
  const divider = `| ${cols.map(() => "---").join(" | ")} |`;
  const rows = result.rows.map(
    (row) => `| ${cols.map((c) => String(row[c] ?? "NULL")).join(" | ")} |`
  );

  const table = [header, divider, ...rows].join("\n");
  const suffix = result.truncated
    ? `\n\n_Results truncated. Showing first ${result.rows.length} of ${result.rowCount} rows._`
    : `\n\n_${result.rowCount} row(s) returned._`;

  return table + suffix;
}
