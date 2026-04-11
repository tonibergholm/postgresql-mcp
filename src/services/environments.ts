import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { TunnelConfig } from "./tunnel.js";

export interface EnvironmentConfig {
  tunnel?: TunnelConfig;
  connection: {
    host?: string;
    port?: number;
    database: string;
    user: string;
    password?: string;
    ssl?: boolean;
  };
}

type EnvironmentsFile = Record<string, EnvironmentConfig>;

function loadJsonFile(path: string): EnvironmentsFile {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as EnvironmentsFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[environments] Failed to load ${path}: ${msg}`);
    return {};
  }
}

// Merge repo-level and user-level configs; user config wins on conflict
function loadEnvironments(): EnvironmentsFile {
  const repoFile = join(__dirname, "..", "..", "environments.json");
  const userFile = join(homedir(), ".config", "gcp-cloudsql-mcp", "environments.json");

  const repoEnvs = existsSync(repoFile) ? loadJsonFile(repoFile) : {};
  const userEnvs = existsSync(userFile) ? loadJsonFile(userFile) : {};

  return { ...repoEnvs, ...userEnvs };
}

export function getEnvironment(name: string): EnvironmentConfig | null {
  const envs = loadEnvironments();
  return envs[name] ?? null;
}

export function listEnvironments(): string[] {
  return Object.keys(loadEnvironments());
}

export function getEnvironmentDetails(): Record<string, { database: string; hasTunnel: boolean }> {
  const envs = loadEnvironments();
  const result: Record<string, { database: string; hasTunnel: boolean }> = {};
  for (const [name, config] of Object.entries(envs)) {
    result[name] = {
      database: config.connection.database,
      hasTunnel: !!config.tunnel,
    };
  }
  return result;
}
