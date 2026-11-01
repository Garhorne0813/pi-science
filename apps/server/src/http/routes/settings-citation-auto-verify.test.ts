import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
async function boot() {
  const config: ServerConfig = { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
  const modules = createServerModules(config);
  const app = buildApp(config, modules); apps.push(app);
  return { app, modules };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-citation-settings-")); roots.push(root); vi.stubEnv("PI_SCIENCE_HOME", root);
  return { root, ...(await boot()) };
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

const config = async (app: { inject: (options: { method: "GET"; url: string }) => Promise<{ json: () => { citation_auto_verify?: boolean } }> }) =>
  (await app.inject({ method: "GET", url: "/api/settings/config" })).json().citation_auto_verify;

it("reports automatic verification as on before the user chose anything", async () => {
  const { app } = await fixture();
  expect(await config(app)).toBe(true);
});

it("reports a stored on and a stored off as stored", async () => {
  const { app } = await fixture();
  await app.inject({ method: "PUT", url: "/api/settings/citation-auto-verify", payload: { enabled: true } });
  expect(await config(app)).toBe(true);
  await app.inject({ method: "PUT", url: "/api/settings/citation-auto-verify", payload: { enabled: false } });
  expect(await config(app)).toBe(false);
});

it("keeps an explicit off on disk so a toggle on then off survives a restart", async () => {
  const { app, root } = await fixture();
  await app.inject({ method: "PUT", url: "/api/settings/citation-auto-verify", payload: { enabled: true } });
  await app.inject({ method: "PUT", url: "/api/settings/citation-auto-verify", payload: { enabled: false } });
  expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toMatchObject({ citation_auto_verify: false });

  // A restarted server re-reads the file with a cold settings store.
  const restarted = await boot();
  expect(await config(restarted.app)).toBe(false);
});

const inlineStyle = async (app: { inject: (options: { method: "GET"; url: string }) => Promise<{ json: () => { citation_inline_style?: string } }> }) =>
  (await app.inject({ method: "GET", url: "/api/settings/config" })).json().citation_inline_style;

it("reports the number style before the user chose anything", async () => {
  const { app, modules } = await fixture();
  expect(await modules.settings.read()).not.toHaveProperty("citation_inline_style");
  expect(await inlineStyle(app)).toBe("number");
});

it("persists the inline citation style and reads the stored value back", async () => {
  const { app, root } = await fixture();
  const saved = await app.inject({ method: "PUT", url: "/api/settings/citation-inline-style", payload: { style: "identifier" } });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({ ok: true, citation_inline_style: "identifier" });
  expect(await inlineStyle(app)).toBe("identifier");
  expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toMatchObject({ citation_inline_style: "identifier" });

  const cleared = await app.inject({ method: "PUT", url: "/api/settings/citation-inline-style", payload: { style: "number" } });
  expect(cleared.json()).toEqual({ ok: true, citation_inline_style: "number" });
  expect(await inlineStyle(app)).toBe("number");
});

it("rejects an inline citation style it does not know without saving it", async () => {
  const { app, modules } = await fixture();
  for (const payload of [{ style: "numeric" }, { style: 1 }, { style: null }, {}]) {
    expect((await app.inject({ method: "PUT", url: "/api/settings/citation-inline-style", payload })).statusCode).toBe(400);
  }
  expect(await modules.settings.read()).not.toHaveProperty("citation_inline_style");
});
