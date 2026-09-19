import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app/app.js";
import type { ServerConfig } from "../../config/config.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
}

describe("Git status route", () => {
  it("reports non-Git projects and rejects unregistered directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-git-route-"));
    workspaces.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    const app = buildApp(config()); apps.push(app);
    const status = await app.inject({ method: "GET", url: `/api/git/status?cwd=${encodeURIComponent(cwd)}` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ is_repository: false, reason: "not_a_repository" });
    const denied = await app.inject({ method: "GET", url: "/api/git/status?cwd=/does/not/exist" });
    expect(denied.statusCode).toBe(403);
  });
});
