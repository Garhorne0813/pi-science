import { spawn } from "node:child_process";
import { buildApp } from "../app/app.js";
import { loadConfig, type ServerConfig } from "../config/config.js";
import { configPath } from "../storage/persistence.js";
import { acquireSingleInstanceLock } from "./instance-lock.js";

export interface LauncherOptions {
  config?: ServerConfig;
  lockPath?: string;
  waitForReady?: (origin: string, timeoutMs?: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<void> | void;
  log?: (message: string) => void;
}

export interface LaunchedServer {
  url: string;
  close(): Promise<void>;
}

async function defaultWaitForReady(origin: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/internal/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Core is still starting; poll again.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pi-Science core did not become ready at ${origin}`);
}

export async function openSystemBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("exit", () => resolve());
    child.unref();
  });
}

export async function launchServer(options: LauncherOptions = {}): Promise<LaunchedServer> {
  const config = options.config ?? loadConfig();
  const lockPath = options.lockPath ?? configPath("instance.lock");
  const lock = await acquireSingleInstanceLock(lockPath);
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    app = buildApp(config);
    const address = await app.listen({ host: config.host, port: config.port });
    const url = typeof address === "string" ? address.replace(/\/$/, "") : `http://${config.host}:${address}`;
    const waitForReady = options.waitForReady ?? defaultWaitForReady;
    await waitForReady(url);
    options.log?.(`Pi-Science core ready at ${url}`);
    if (options.openBrowser) await options.openBrowser(url);
    return {
      url,
      close: async () => {
        await app?.close();
        await lock.release();
      },
    };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await lock.release();
    throw error;
  }
}