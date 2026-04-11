import { ChildProcess, spawn } from "child_process";
import { createConnection } from "net";

export interface TunnelConfig {
  project: string;
  zone: string;
  bastion: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
}

let tunnelProcess: ChildProcess | null = null;
let activeTunnelConfig: TunnelConfig | null = null;

function probeTcpPort(port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host, timeout: timeoutMs });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port: number, host = "127.0.0.1", maxWaitMs = 45000, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await probeTcpPort(port, host)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Tunnel did not become ready on ${host}:${port} within ${maxWaitMs / 1000}s`);
}

export async function startTunnel(config: TunnelConfig): Promise<void> {
  // If a tunnel is already running for the same config, reuse it
  if (tunnelProcess && activeTunnelConfig) {
    const same =
      activeTunnelConfig.project === config.project &&
      activeTunnelConfig.bastion === config.bastion &&
      activeTunnelConfig.remoteHost === config.remoteHost &&
      activeTunnelConfig.remotePort === config.remotePort &&
      activeTunnelConfig.localPort === config.localPort;
    if (same && await probeTcpPort(config.localPort)) {
      console.error(`[tunnel] Reusing existing tunnel on port ${config.localPort}`);
      return;
    }
  }

  await stopTunnel();

  // Check if something is already listening on the local port (user-managed tunnel)
  if (await probeTcpPort(config.localPort)) {
    console.error(`[tunnel] Port ${config.localPort} already open — assuming external tunnel`);
    activeTunnelConfig = config;
    return;
  }

  const portForward = `${config.localPort}:${config.remoteHost}:${config.remotePort}`;
  const args = [
    "compute", "ssh",
    "--tunnel-through-iap",
    `--project=${config.project}`,
    `--zone=${config.zone}`,
    config.bastion,
    "--", "-N", "-L", portForward,
  ];

  console.error(`[tunnel] Starting: gcloud ${args.join(" ")}`);

  const child = spawn("gcloud", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    shell: true,
  });

  // Capture stderr for diagnostics
  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  child.on("error", (err) => {
    console.error(`[tunnel] Process error: ${err.message}`);
    tunnelProcess = null;
    activeTunnelConfig = null;
  });

  child.on("exit", (code, signal) => {
    if (tunnelProcess === child) {
      console.error(`[tunnel] Exited (code=${code}, signal=${signal})`);
      if (stderrBuf.trim()) console.error(`[tunnel] stderr: ${stderrBuf.trim()}`);
      tunnelProcess = null;
      activeTunnelConfig = null;
    }
  });

  tunnelProcess = child;
  activeTunnelConfig = config;

  // Wait for the tunnel to become reachable
  try {
    await waitForPort(config.localPort);
    console.error(`[tunnel] Ready on localhost:${config.localPort}`);
  } catch (err) {
    // Tunnel failed to come up — clean up
    await stopTunnel();
    const hint = stderrBuf.trim() ? `\ngcloud stderr: ${stderrBuf.trim()}` : "";
    throw new Error(`IAP tunnel failed to start.${hint}`);
  }
}

export async function stopTunnel(): Promise<void> {
  if (tunnelProcess) {
    const pid = tunnelProcess.pid;
    console.error(`[tunnel] Stopping (pid=${pid})`);
    tunnelProcess.kill("SIGTERM");
    // Give it a moment, then force kill
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (tunnelProcess && !tunnelProcess.killed) {
          tunnelProcess.kill("SIGKILL");
        }
        resolve();
      }, 3000);
      tunnelProcess!.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    tunnelProcess = null;
    activeTunnelConfig = null;
  }
}

export function isTunnelRunning(): boolean {
  return tunnelProcess !== null && !tunnelProcess.killed;
}

export function getActiveTunnelConfig(): TunnelConfig | null {
  return activeTunnelConfig;
}
