import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../config/config.js";
import { launchServer } from "./launcher.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

function testConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    corsOrigins: [],
    maxBodyBytes: 10 * 1024 * 1024,
    upstreamTimeoutMs: 100,
    nodeSessions: false,
    nodeSse: false,
    nodeFiles: false,
    nodePiManager: false,
    logLevel: "silent",
  };
}

describe("launcher", () => {
  it("starts the core on an available port and releases the instance lock on close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-science-launcher-app-"));
    cleanup.push(dir);
    const lockPath = join(dir, "instance.lock");

    const launched = await launchServer({ config: testConfig(), lockPath });
    expect(launched.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${launched.url}/internal/ready`);
    expect(response.status).toBe(200);
    expect(await readFile(lockPath, "utf8")).toContain(String(process.pid));

    await launched.close();
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });
});