import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../app/app.js";
import { createServerModules } from "../../app/server-modules.js";
import type { ServerConfig } from "../../config/config.js";

const flash = "deepseek/deepseek-flash";
const pro = "deepseek/deepseek-v4-pro";
const config: ServerConfig = { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 1000000, upstreamTimeoutMs: 100,
  nodeSessions: false, nodeSse: false, nodeFiles: false, nodePiManager: false, logLevel: "silent" };
let root: string;
let cwd: string;
let home: string;
let modules: ReturnType<typeof createServerModules>;
let app: ReturnType<typeof buildApp>;
beforeEach(async () => {
  const scratch = fileURLToPath(new URL("../../../../../.cache/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "selection-v2-"));
  cwd = join(root, "workspace"); home = join(root, "home");
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  await mkdir(home);
  vi.stubEnv("PI_SCIENCE_HOME", home);
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("PI_CLI_PATH", "");
  modules = createServerModules(config, { sqliteEnabled: false });
  app = buildApp(config, modules);
  expect((await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "deepseek", api_key: "synthetic-ownership-key" } })).statusCode).toBe(200);
  expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: flash, thinking: "off" } })).statusCode).toBe(200);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await modules?.sessions.shutdownAll();
  await app?.close();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const path = (id: string) => `/api/sessions/${id}/model-selection?cwd=${encodeURIComponent(cwd)}`;
async function create() {
  const result = await modules.sessions.create({ cwd, config: { skills: [], extensions: [] } });
  if (!("id" in result)) throw new Error(result.error);
  return result.id;
}
async function selection(id: string) {
  const response = await app.inject({ method: "GET", url: path(id) });
  expect(response.statusCode).toBe(200);
  return response.json().selection;
}
describe("ModelSelection v2", () => {
  it("separates defaults, existing sessions and cold durable resumes", async () => {
    const reload = vi.spyOn(modules.sessions, "reloadConfiguration");
    const a = await create();
    expect((await app.inject({ method: "PUT", url: path(a), payload: { model: pro, thinking: "high" } })).statusCode).toBe(200);
    expect(await selection(a)).toEqual({ model: pro, thinking: "high" });
    expect((await app.inject({ method: "GET", url: "/api/model-selection/default" })).json().selection).toEqual({ model: flash, thinking: "off" });
    const b = await create();
    expect(await selection(b)).toEqual({ model: flash, thinking: "off" });
    expect(modules.sessions.processCount).toBe(2);
    expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: pro, thinking: "max" } })).statusCode).toBe(200);
    expect(modules.sessions.processCount).toBe(2);
    expect(await selection(a)).toEqual({ model: pro, thinking: "high" });
    expect(await selection(b)).toEqual({ model: flash, thinking: "off" });
    const c = await create();
    expect(await selection(c)).toEqual({ model: pro, thinking: "max" });
    expect(reload).not.toHaveBeenCalled();
    await modules.sessions.shutdownAll();
    expect(modules.sessions.processCount).toBe(0);
    for (const [id, model, thinking] of [[a, pro, "high"], [b, flash, "off"], [c, pro, "max"]]) {
      expect(await selection(id!)).toEqual({ model, thinking });
      expect(await modules.sessions.resume(id!, cwd)).toMatchObject({ success: true });
      expect(await selection(id!)).toEqual({ model, thinking });
    }
  }, 30000);
  it("keeps default reads lightweight and rejects malformed or unavailable writes", async () => {
    const catalog = vi.spyOn(modules.runtimeCatalog, "getCatalog");
    const models = vi.spyOn(modules.sessions, "availableModels");
    const configure = vi.spyOn(modules.sessions, "configure");
    const write = vi.spyOn(modules.settings, "update");
    expect((await app.inject({ method: "GET", url: "/api/model-selection/default" })).json()).toMatchObject({ scope: "default", selection: { model: flash, thinking: "off" } });
    expect(catalog).not.toHaveBeenCalled(); expect(models).not.toHaveBeenCalled();
    for (const payload of [{ model: flash, thinking: "unknown" }, { model: "invalid", thinking: "off" }, { model: flash, thinking: "off", session_id: "injected" }]) {
      expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: "user-missing/model", thinking: "off" } })).statusCode).toBe(422);
    const available = (await app.inject({ method: "GET", url: "/api/model-selection/catalog" })).json().available_models;
    const levels = available.find((model: { id: string }) => model.id === flash).thinking_levels;
    const unsupported = ["minimal", "low", "medium", "high", "xhigh", "max"].find((level) => !levels.includes(level));
    expect(unsupported).toBeDefined();
    expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: flash, thinking: unsupported } })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/sessions/missing/model-selection" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: path("missing") })).statusCode).toBe(404);
    expect(write).not.toHaveBeenCalled(); expect(configure).not.toHaveBeenCalled();
  });
  it("isolates failed/busy session writes and clearing defaults from existing sessions", async () => {
    const a = await create();
    const before = await readFile(join(home, "config.json"), "utf8");
    const configure = vi.spyOn(modules.sessions, "configure").mockResolvedValue({ success: false, code: "busy", error: "agent is busy" });
    const failed = await app.inject({ method: "PUT", url: path(a), payload: { model: pro, thinking: "high" } });
    expect(failed.statusCode).toBe(409);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(before);
    expect(await selection(a)).toEqual({ model: flash, thinking: "off" });
    configure.mockRestore();
    expect((await app.inject({ method: "PUT", url: path(a), payload: { model: null, thinking: "off" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: null, thinking: "off" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/model-selection/default" })).json().selection).toEqual({ model: null, thinking: "off" });
    expect(await selection(a)).toEqual({ model: flash, thinking: "off" });
    expect(await modules.sessions.create({ cwd, config: { skills: [], extensions: [] } })).toMatchObject({ code: "invalid_model" });
    // A workspace draft can still create a session with an explicit selection.
    const draft = await modules.sessions.create({ cwd, config: { model: pro, thinking: "high", skills: [], extensions: [] } });
    expect(draft).toHaveProperty("id");
  }, 30000);
});
