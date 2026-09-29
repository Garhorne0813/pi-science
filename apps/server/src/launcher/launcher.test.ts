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

  it("publishes its own origin and generated token for the sandbox runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-science-launcher-env-"));
    cleanup.push(dir);
    const restore = stashControlPlaneEnv();
    delete process.env.PI_SCIENCE_BACKEND_URL;
    delete process.env.PI_SCIENCE_INTERNAL_TOKEN;
    try {
      const launched = await launchServer({
        config: { ...testConfig(), internalToken: "generated-token", requireInternalToken: true },
        lockPath: join(dir, "instance.lock"),
      });
      // The managed Pi Orbit runtime inherits this environment and its sandbox
      // extension calls back into /api/jobs/conversation with it. A generated
      // token or a non-default port must not leave that call unauthenticated.
      expect(process.env.PI_SCIENCE_BACKEND_URL).toBe(launched.url);
      expect(process.env.PI_SCIENCE_INTERNAL_TOKEN).toBe("generated-token");
      await launched.close();
    } finally {
      restore();
    }
  });

  it("keeps an explicitly configured control-plane origin and token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-science-launcher-env-"));
    cleanup.push(dir);
    const restore = stashControlPlaneEnv();
    process.env.PI_SCIENCE_BACKEND_URL = "http://127.0.0.1:9999";
    process.env.PI_SCIENCE_INTERNAL_TOKEN = "explicit-token";
    try {
      const launched = await launchServer({
        config: { ...testConfig(), internalToken: "generated-token", requireInternalToken: true },
        lockPath: join(dir, "instance.lock"),
      });
      expect(process.env.PI_SCIENCE_BACKEND_URL).toBe("http://127.0.0.1:9999");
      expect(process.env.PI_SCIENCE_INTERNAL_TOKEN).toBe("explicit-token");
      await launched.close();
    } finally {
      restore();
    }
  });
});

function stashControlPlaneEnv(): () => void {
  const previous = { url: process.env.PI_SCIENCE_BACKEND_URL, token: process.env.PI_SCIENCE_INTERNAL_TOKEN };
  return () => {
    if (previous.url === undefined) delete process.env.PI_SCIENCE_BACKEND_URL;
    else process.env.PI_SCIENCE_BACKEND_URL = previous.url;
    if (previous.token === undefined) delete process.env.PI_SCIENCE_INTERNAL_TOKEN;
    else process.env.PI_SCIENCE_INTERNAL_TOKEN = previous.token;
  };
}