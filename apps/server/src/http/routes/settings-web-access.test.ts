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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-settings-"));
  roots.push(root);
  vi.stubEnv("PI_SCIENCE_HOME", root);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    corsOrigins: [],
    maxBodyBytes: 10_000_000,
    upstreamTimeoutMs: 100,
    nodeSessions: false,
    nodeSse: false,
    nodeFiles: true,
    nodePiManager: false,
    logLevel: "silent",
  };
  const modules = createServerModules(config);
  const reload = vi.spyOn(modules.sessions, "reloadConfiguration").mockResolvedValue([]);
  const app = buildApp(config, modules);
  apps.push(app);
  return { root, app, modules, reload };
}
it("persists tool switches and provider credentials, hides secrets, and reloads existing workers", async () => {
  const { app, modules, reload } = await fixture();
  expect((await app.inject({ method: "GET", url: "/api/settings/web-access" })).json()).toEqual({
    web_access: { search_enabled: true, fetch_enabled: true, provider: "auto", api_keys: {} },
  });
  const saved = await app.inject({
    method: "PUT",
    url: "/api/settings/web-access",
    payload: { search_enabled: false, provider: "brave", api_keys: { brave: "secret-fixture" } },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.body).not.toContain("secret-fixture");
  expect(saved.json()).toMatchObject({
    ok: true,
    web_access: {
      search_enabled: false,
      fetch_enabled: true,
      provider: "brave",
      api_keys: { brave: true },
    },
  });
  expect(reload).toHaveBeenCalledOnce();
  expect(await modules.settings.read()).toMatchObject({
    web_access: { credential_refs: { brave: expect.any(String) } },
  });
  expect(JSON.stringify(await modules.settings.read())).not.toContain("secret-fixture");
  const updated = await app.inject({
    method: "PUT",
    url: "/api/settings/web-access",
    payload: { fetch_enabled: false },
  });
  expect(updated.json().web_access).toMatchObject({
    search_enabled: false,
    fetch_enabled: false,
    provider: "brave",
    api_keys: { brave: true },
  });
  const removed = await app.inject({
    method: "PUT",
    url: "/api/settings/web-access",
    payload: { api_keys: { brave: "" } },
  });
  expect(removed.json().web_access.api_keys.brave).toBe(false);
});
it("rejects invalid provider, key, and SSRF settings without saving or reloading", async () => {
  const { app, reload, modules } = await fixture();
  for (const payload of [
    { provider: "unknown" },
    { search_enabled: "false" },
    { api_keys: { brave: true } },
    { ssrf: { allowRanges: ["127.0.0.0/8"] } },
  ]) {
    expect(
      (await app.inject({ method: "PUT", url: "/api/settings/web-access", payload })).statusCode,
    ).toBe(400);
  }
  expect(reload).not.toHaveBeenCalled();
  expect(await modules.settings.read()).not.toHaveProperty("web_access");
});
it("saves DeepSeek credentials by reference and keeps them on partial updates", async () => {
  const { app, modules } = await fixture();
  const saved = await app.inject({
    method: "PUT",
    url: "/api/settings/web-access",
    payload: { provider: "deepseek", api_keys: { deepseek: "deepseek-test-secret" } },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.body).not.toContain("deepseek-test-secret");
  expect(saved.json().web_access).toMatchObject({
    provider: "deepseek",
    api_keys: { deepseek: true },
  });
  expect(JSON.stringify(await modules.settings.read())).not.toContain("deepseek-test-secret");
  expect(await modules.settings.read()).toMatchObject({
    web_access: { credential_refs: { deepseek: expect.any(String) } },
  });
  const updated = await app.inject({
    method: "PUT",
    url: "/api/settings/web-access",
    payload: { fetch_enabled: false },
  });
  expect(updated.json().web_access).toMatchObject({
    provider: "deepseek",
    api_keys: { deepseek: true },
    fetch_enabled: false,
  });
});
