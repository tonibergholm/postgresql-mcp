import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ConnectionConfig } from "./database.js";

const CONFIG_DIR = join(homedir(), ".config", "gcp-cloudsql-mcp");
const CONFIG_FILE = join(CONFIG_DIR, "connection.json");

export function saveConnectionConfig(config: ConnectionConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function loadConnectionConfig(): ConnectionConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as ConnectionConfig;
  } catch {
    return null;
  }
}

export function clearConnectionConfig(): void {
  if (existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, "", { mode: 0o600 });
  }
}

export { CONFIG_FILE };
