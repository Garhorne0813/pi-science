import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProgressAppearance } from "@pi-science/contracts";
import { buildApp } from "../../app/app.js";
import { createServerModules } from "../../app/server-modules.js";
import type { ServerConfig } from "../../config/config.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  delete process.env.PI_SCIENCE_HOME;
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
}

describe("progress appearance settings", () => {
  it("persists UI-only progress changes without reloading active runtimes", async () => {
    const home = join(tmpdir(), `pi-science-progress-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(home);
    await mkdir(home, { recursive: true });
    process.env.PI_SCIENCE_HOME = home;

    const modules = createServerModules(config());
    const reload = vi.spyOn(modules.sessions, "reloadConfiguration").mockResolvedValue([]);
    const app = buildApp(config(), modules);
    apps.push(app);
    const progress = { ...structuredClone(defaultProgressAppearance), speed: 1.5 };

    const response = await app.inject({ method: "PUT", url: "/api/settings/progress", payload: progress });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, progress_appearance: progress });
    expect(response.json()).not.toHaveProperty("session_replacements");
    expect(reload).not.toHaveBeenCalled();
    await expect(modules.settings.read()).resolves.toMatchObject({ progress_appearance: progress });
  });

  it("reads the stored appearance from the dedicated lightweight route", async () => {
    const home = join(tmpdir(), `pi-science-progress-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(home);
    await mkdir(home, { recursive: true });
    process.env.PI_SCIENCE_HOME = home;

    const modules = createServerModules(config());
    const app = buildApp(config(), modules);
    apps.push(app);
    const progress = { ...structuredClone(defaultProgressAppearance), speed: 0.75, motion: "full" as const };

    await app.inject({ method: "PUT", url: "/api/settings/progress", payload: progress });
    const response = await app.inject({ method: "GET", url: "/api/settings/progress" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ progress_appearance: progress });
  });

  it("rejects invalid appearances without writing and keeps other settings", async () => {
    const home = join(tmpdir(), `pi-science-progress-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(home);
    await mkdir(home, { recursive: true });
    process.env.PI_SCIENCE_HOME = home;

    const modules = createServerModules(config());
    const reload = vi.spyOn(modules.sessions, "reloadConfiguration").mockResolvedValue([]);
    const app = buildApp(config(), modules);
    apps.push(app);

    const invalid = { ...structuredClone(defaultProgressAppearance), speed: 9 };
    const response = await app.inject({ method: "PUT", url: "/api/settings/progress", payload: invalid });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error", "Invalid progress appearance settings");
    await expect(modules.settings.read()).resolves.not.toHaveProperty("progress_appearance.speed", 9);
    expect(reload).not.toHaveBeenCalled();
  });
});
