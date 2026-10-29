import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../app/app.js";
import { createServerModules } from "../../app/server-modules.js";
import type { ServerConfig } from "../../config/config.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-citation-settings-")); roots.push(root); vi.stubEnv("PI_SCIENCE_HOME", root);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
  const modules = createServerModules(config);
  const app = buildApp(config, modules); apps.push(app);
  return { app, modules };
}

it("persists the automatic citation verification switch and reads it back", async () => {
  const { app, modules } = await fixture();
  expect(await modules.settings.read()).not.toHaveProperty("citation_auto_verify");

  const saved = await app.inject({ method: "PUT", url: "/api/settings/citation-auto-verify", payload: { enabled: true } });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({ ok: true, citation_auto_verify: true });
  expect(await modules.settings.read()).toMatchObject({ citation_auto_verify: true });

  const cleared = await app.inject({ method: "PUT", url: "/api/settings/citation-auto-verify", payload: { enabled: false } });
  expect(cleared.json()).toEqual({ ok: true, citation_auto_verify: false });
  expect(await modules.settings.read()).toMatchObject({ citation_auto_verify: false });
});

it("rejects a non-boolean value without saving it", async () => {
  const { app, modules } = await fixture();
  for (const payload of [{ enabled: "true" }, { enabled: 1 }, {}]) {
    expect((await app.inject({ method: "PUT", url: "/api/settings/citation-auto-verify", payload })).statusCode).toBe(400);
  }
  expect(await modules.settings.read()).not.toHaveProperty("citation_auto_verify");
});
