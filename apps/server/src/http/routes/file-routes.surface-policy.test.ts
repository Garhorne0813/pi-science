import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../app/app.js";
import type { ServerConfig } from "../../config/config.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
}

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `pi-science-file-surface-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(path);
  await mkdir(join(path, ".pi-science"), { recursive: true });
  return path;
}

describe("automatic file surface policy", () => {
  it("rejects sensitive paths and safe-looking symlinks while preserving explicit reads", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    await mkdir(join(cwd, "results"), { recursive: true });
    await writeFile(join(cwd, "credentials.json"), "super-secret", "utf8");
    await writeFile(join(cwd, "results", "safe.txt"), "safe", "utf8");
    await symlink("../credentials.json", join(cwd, "results", "report.txt"));

    const app = buildApp(config());
    apps.push(app);
    const encodedCwd = encodeURIComponent(cwd);

    const safeProbe = await app.inject({ method: "GET", url: `/api/files/probe/results/safe.txt?cwd=${encodedCwd}` });
    expect(safeProbe.statusCode).toBe(200);

    const directSensitiveProbe = await app.inject({ method: "GET", url: `/api/files/probe/credentials.json?cwd=${encodedCwd}` });
    expect(directSensitiveProbe.statusCode).toBe(404);

    const symlinkProbe = await app.inject({ method: "GET", url: `/api/files/probe/results/report.txt?cwd=${encodedCwd}` });
    expect(symlinkProbe.statusCode).toBe(404);

    const automaticSnippet = await app.inject({ method: "GET", url: `/api/files/results/report.txt?cwd=${encodedCwd}&maxBytes=8192` });
    expect(automaticSnippet.statusCode).toBe(403);

    const automaticServe = await app.inject({ method: "GET", url: `/api/files/serve/results/report.txt?cwd=${encodedCwd}` });
    expect(automaticServe.statusCode).toBe(403);

    const explicitRead = await app.inject({ method: "GET", url: `/api/files/results/report.txt?cwd=${encodedCwd}` });
    expect(explicitRead.statusCode).toBe(200);
    expect(explicitRead.json().data).toBe("super-secret");
  });
});
