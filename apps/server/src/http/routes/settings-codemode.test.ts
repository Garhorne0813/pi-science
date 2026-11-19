import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../app/app.js";
import { createServerModules } from "../../app/server-modules.js";
import type { ServerConfig } from "../../config/config.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const roots: string[] = [];
const config = (): ServerConfig => ({ host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.PI_SCIENCE_HOME;
});

describe("Codemode settings", () => {
  it("persists the switch, exposes it in config, and reloads active runtimes", async () => {
    const home = join(tmpdir(), `pi-science-codemode-${Date.now()}`);
    roots.push(home);
    await mkdir(home, { recursive: true });
    process.env.PI_SCIENCE_HOME = home;
    const modules = createServerModules(config());
    const reload = vi.spyOn(modules.sessions, "reloadConfiguration").mockResolvedValue([]);
    const app = buildApp(config(), modules);
    apps.push(app);

    const saved = await app.inject({ method: "PUT", url: "/api/settings/codemode", payload: { enabled: true } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ok: true, codemode_enabled: true, session_replacements: [] });
    expect(reload).toHaveBeenCalledOnce();
    await expect(modules.settings.read()).resolves.toMatchObject({ codemode_enabled: true });

    const read = await app.inject({ method: "GET", url: "/api/settings/config" });
    expect(read.json()).toMatchObject({ codemode_enabled: true });
  });

  it("rejects non-boolean values without changing settings", async () => {
    const home = join(tmpdir(), `pi-science-codemode-invalid-${Date.now()}`);
    roots.push(home);
    await mkdir(home, { recursive: true });
    process.env.PI_SCIENCE_HOME = home;
    const modules = createServerModules(config());
    const app = buildApp(config(), modules);
    apps.push(app);

    const response = await app.inject({ method: "PUT", url: "/api/settings/codemode", payload: { enabled: "yes" } });
    expect(response.statusCode).toBe(400);
    await expect(modules.settings.read()).resolves.not.toHaveProperty("codemode_enabled");
  });
});
