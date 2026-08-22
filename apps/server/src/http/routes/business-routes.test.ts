import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../app/app.js";
import type { ServerConfig } from "../../config/config.js";
import { nodeSessionService } from "../../runtime/node/node-session-service.js";
import { ResearchRepository } from "../../research-loop/repository.js";
import { createServerModules } from "../../app/server-modules.js";
import { loadPiAiProviderCatalog } from "../../config/pi-ai-provider-catalog.js";

// The real pi-ai provider catalog is installed by scripts/fetch-pi.sh, which
// CI does not run; without it provider inventory/catalog assertions have
// nothing real to validate and are skipped there. Installed machines keep
// full coverage.
const piAiCatalogAvailable = (await loadPiAiProviderCatalog()).length > 0;

const apps: Array<{ close(): Promise<unknown> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  delete process.env.PI_SCIENCE_HOME;
  delete process.env.PI_SCIENCE_WORKSPACES;
  delete process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS;
  delete process.env.DEEPSEEK_API_KEY;
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: false, nodeSse: false, nodeFiles: true, nodePiManager: false, logLevel: "silent" };
}

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `pi-science-business-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(path); await mkdir(join(path, ".pi-science"), { recursive: true }); await mkdir(join(path, ".pi", "skills"), { recursive: true }); return path;
}

describe("native control-plane business routes", () => {
  it("persists the unified skill policy without replacing active sessions", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const app = buildApp(config());
    apps.push(app);
    const catalog = await app.inject({ method: "GET", url: `/api/skills?cwd=${encodeURIComponent(cwd)}` });
    const skill = catalog.json()[0] as { name: string };

    const toggled = await app.inject({
      method: "PUT",
      url: "/api/settings/skills/toggle",
      payload: { name: skill.name, enabled: false },
    });

    expect(toggled.statusCode).toBe(200);
    expect(toggled.json()).toMatchObject({ ok: true, configured: true, policy: { mode: "denylist", skills: [skill.name] } });
    expect(toggled.json()).not.toHaveProperty("session_replacements");
    const listed = await app.inject({ method: "GET", url: "/api/settings/skills" });
    expect(listed.json().skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: skill.name, enabled: false })]));

    const reset = await app.inject({ method: "DELETE", url: "/api/settings/skills" });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ ok: true, configured: false, policy: { mode: "inherit" } });
  }, 30_000);

  it("rejects option-like environment package specs after trimming", async () => {
    const app = buildApp(config());
    apps.push(app);

    const create = await app.inject({ method: "POST", url: "/api/environments", payload: { name: "unsafe", packages: [" --file=/host/packages.txt"] } });
    const install = await app.inject({ method: "POST", url: "/api/environments/workspace/packages", payload: { packages: [" --file=/host/packages.txt"] } });

    expect(create.statusCode).toBe(400);
    expect(install.statusCode).toBe(400);
  });

  it("does not overwrite an existing incomplete workspace environment", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".venv"), { recursive: true });
    await writeFile(join(cwd, ".venv", "keep.txt"), "user-owned", "utf8");
    const app = buildApp(config());
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/environments/workspace?cwd=${encodeURIComponent(cwd)}` });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toContain("incomplete");
    await expect(readFile(join(cwd, ".venv", "keep.txt"), "utf8")).resolves.toBe("user-owned");
  });

  it("provisions an isolated Python environment inside the workspace", async () => {
    const cwd = await workspace();
    const app = buildApp(config());
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/environments/workspace?cwd=${encodeURIComponent(cwd)}`,
    });

    expect(response.statusCode).toBe(200);
    const environment = response.json();
    expect(environment).toMatchObject({
      ready: true,
      workspace: expect.any(String),
      prefix: join(environment.workspace, ".venv"),
      python: expect.stringContaining(join(environment.workspace, ".venv")),
      npm: { local_prefix: environment.workspace },
    });
    await expect(access(environment.python)).resolves.toBeUndefined();

    const submitted = await app.inject({
      method: "POST",
      url: `/api/jobs?cwd=${encodeURIComponent(cwd)}`,
      payload: { command: ["python", "-c", "import sys; print(sys.prefix)"] },
    });
    expect(submitted.statusCode).toBe(200);
    let job = submitted.json();
    for (let attempt = 0; attempt < 100 && ["pending", "running"].includes(job.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = (await app.inject({ method: "GET", url: `/api/jobs/${job.job_id}?cwd=${encodeURIComponent(cwd)}` })).json();
    }
    expect(job).toMatchObject({ status: "succeeded" });
    expect(job.stdout.trim()).toBe(environment.prefix);
  }, 30_000);

  it("uses Pi runtime model capabilities for workspace settings", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({ model: "openrouter/openai/gpt-5.1", thinking: "xhigh" }), "utf8");
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValueOnce({
      success: true,
      data: {
        models: [
          { provider: "openrouter", id: "openai/gpt-5.1", name: "GPT-5.1", reasoning: true, contextWindow: 200000, thinkingLevelMap: { xhigh: "xhigh", max: null } },
          { provider: "openrouter", id: "openai/gpt-4o", name: "GPT-4o", reasoning: false },
        ],
      },
    });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      model: "openrouter/openai/gpt-5.1",
      model_catalog_source: "pi",
      available_models: [
        { id: "openrouter/openai/gpt-5.1", reasoning: true, thinking_levels: ["off", "minimal", "low", "medium", "high", "xhigh"], context_window: 200000 },
        { id: "openrouter/openai/gpt-4o", reasoning: false, thinking_levels: ["off"] },
      ],
    });
  });

  it("overrides the configured model's thinking levels with the live runtime's actual levels", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({ model: "openrouter/openai/gpt-5.1", thinking: "max" }), "utf8");
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [
        { provider: "openrouter", id: "openai/gpt-5.1", name: "GPT-5.1", reasoning: true, contextWindow: 200000, thinkingLevelMap: { xhigh: "xhigh", max: null } },
      ] },
    });
    // The runtime is the final authority for the CURRENT model: it reports
    // only off/high even though the catalog hint claims more.
    vi.spyOn(nodeSessionService, "availableThinkingLevels").mockResolvedValue({ success: true, data: { levels: ["off", "high"], model: "openrouter/openai/gpt-5.1" } });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      model: "openrouter/openai/gpt-5.1",
      // "max" is not supported by the actual levels; the returned value clamps down.
      thinking: "high",
      available_models: [
        { id: "openrouter/openai/gpt-5.1", reasoning: true, thinking_levels: ["off", "high"], context_window: 200000 },
      ],
    });
  });

  it("keeps catalog levels when the live runtime reports a different model identity", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({ model: "deepseek/deepseek-v4-flash", thinking: "max" }), "utf8");
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [
        { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, contextWindow: 1_000_000, thinkingLevelMap: { high: "high", max: "max" } },
      ] },
    });
    // The runtime is running a DIFFERENT model than the configured one: the
    // route must not apply its levels or clamp with them.
    vi.spyOn(nodeSessionService, "availableThinkingLevels").mockResolvedValue({ success: true, data: { levels: ["off", "low"], model: "custom-other/provider-2" } });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      // Catalog levels stay authoritative; the unrelated runtime is ignored.
      thinking: "max",
      available_models: [
        { id: "deepseek/deepseek-v4-flash", reasoning: true, thinking_levels: ["off", "minimal", "low", "medium", "high", "max"], context_window: 1000000 },
      ],
    });
  });

  it("clamps a saved thinking level to the selected model's supported levels", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [
        { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, contextWindow: 1_000_000, thinkingLevelMap: { high: "high" } },
      ] },
    });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const saved = await app.inject({ method: "PUT", url: `/api/settings/model?cwd=${encodeURIComponent(cwd)}`, payload: { model: "deepseek/deepseek-v4-flash", thinking: "max" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ok: true, model: "deepseek/deepseek-v4-flash", thinking: "high" });
    // The persisted value matches the response (never an unsupported level).
    const stored = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME, "config.json"), "utf8"));
    expect(stored).toMatchObject({ model: "deepseek/deepseek-v4-flash", thinking: "high" });
  });

  it("persists the runtime-clamped thinking level on GET config (self-heal)", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({ model: "openrouter/openai/gpt-5.1", thinking: "max" }), "utf8");
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [{ provider: "openrouter", id: "openai/gpt-5.1", name: "GPT-5.1", reasoning: true, contextWindow: 200000, thinkingLevelMap: { xhigh: "xhigh", max: null } }] },
    });
    vi.spyOn(nodeSessionService, "availableThinkingLevels").mockResolvedValue({ success: true, data: { levels: ["off", "high"], model: "openrouter/openai/gpt-5.1" } });
    const reload = vi.spyOn(nodeSessionService, "reloadConfiguration");
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ model: "openrouter/openai/gpt-5.1", thinking: "high" });
    // The corrected level is durable: a cold read (no live runtime) must see
    // the same value, and the GET self-heal never triggers a runtime reload.
    const stored = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME, "config.json"), "utf8"));
    expect(stored).toMatchObject({ model: "openrouter/openai/gpt-5.1", thinking: "high" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("corrects and persists the context window from the live runtime catalog on GET config", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    // A stale persisted window; the live runtime reports the authoritative value.
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({ model: "openrouter/openai/gpt-5.1", thinking: "high", model_context_window: 128000 }), "utf8");
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [{ provider: "openrouter", id: "openai/gpt-5.1", name: "GPT-5.1", reasoning: true, contextWindow: 200000, thinkingLevelMap: { xhigh: "xhigh", max: null } }] },
    });
    const reload = vi.spyOn(nodeSessionService, "reloadConfiguration");
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ model: "openrouter/openai/gpt-5.1", model_context_window: 200000 });
    // The corrected window is durable; GET self-heal never reloads the runtime.
    const stored = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME, "config.json"), "utf8"));
    expect(stored).toMatchObject({ model: "openrouter/openai/gpt-5.1", model_context_window: 200000 });
    expect(reload).not.toHaveBeenCalled();
  });

  it("persists runtime capabilities into custom provider model hints on GET config", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({
      model: "custom-local-provider/local-model",
      thinking: "off",
      model_context_window: 64000,
      custom_providers: [{ id: "local-provider", name: "Local Provider", base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", models: ["local-model"], reasoning: true, context_window: 64000, model_hints: { "local-model": { reasoning: false, context_window: 64000, source: "manual" } } }],
    }), "utf8");
    // The live runtime is the authority: it reports a larger window and the
    // actual thinking levels for the running model.
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [{ provider: "custom-local-provider", id: "local-model", name: "Local Model", reasoning: true, contextWindow: 262144, thinkingLevelMap: { off: "off", high: "high" } }] },
    });
    vi.spyOn(nodeSessionService, "availableThinkingLevels").mockResolvedValue({ success: true, data: { levels: ["off", "high"], model: "custom-local-provider/local-model" } });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ model: "custom-local-provider/local-model", model_context_window: 262144 });
    const model = settings.json().available_models.find((item: { id: string }) => item.id === "custom-local-provider/local-model");
    expect(model).toMatchObject({ context_window: 262144, reasoning: true, thinking_levels: ["off", "high"] });
    // The per-model hint is corrected in place: window always, reasoning and
    // levels only when the runtime verified the configured model identity.
    const stored = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME, "config.json"), "utf8"));
    expect(stored).toMatchObject({ model: "custom-local-provider/local-model", model_context_window: 262144 });
    expect(stored.custom_providers[0].model_hints["local-model"]).toMatchObject({ context_window: 262144, reasoning: true, thinking_levels: ["off", "high"], source: "pi-runtime" });
  });

  it("corrects the persisted thinking level to the runtime's actual levels after model PUT", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, contextWindow: 1_000_000, thinkingLevelMap: { off: "off", low: "low", minimal: null, medium: null, high: null } }] },
    });
    // The catalog only allows low, but the reloaded runtime reports high/max:
    // the response AND the persisted config must both settle on high.
    vi.spyOn(nodeSessionService, "availableThinkingLevels").mockResolvedValue({ success: true, data: { levels: ["high", "max"], model: "deepseek/deepseek-v4-flash" } });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const saved = await app.inject({ method: "PUT", url: `/api/settings/model?cwd=${encodeURIComponent(cwd)}`, payload: { model: "deepseek/deepseek-v4-flash", thinking: "high" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ok: true, model: "deepseek/deepseek-v4-flash", thinking: "high" });
    const stored = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME, "config.json"), "utf8"));
    expect(stored).toMatchObject({ model: "deepseek/deepseek-v4-flash", thinking: "high" });
  });

  it("keeps the catalog-clamped level when the reloaded runtime runs a different model", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, contextWindow: 1_000_000, thinkingLevelMap: { off: "off", low: "low", minimal: null, medium: null, high: null } }] },
    });
    // The reloaded runtime is running a DIFFERENT model: its levels must not
    // be written back to the config or echoed in the response.
    vi.spyOn(nodeSessionService, "availableThinkingLevels").mockResolvedValue({ success: true, data: { levels: ["high", "max"], model: "custom-other/provider-2" } });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const saved = await app.inject({ method: "PUT", url: `/api/settings/model?cwd=${encodeURIComponent(cwd)}`, payload: { model: "deepseek/deepseek-v4-flash", thinking: "high" } });
    expect(saved.statusCode).toBe(200);
    // Catalog clamp stands (high -> low); the foreign runtime is ignored.
    expect(saved.json()).toMatchObject({ ok: true, model: "deepseek/deepseek-v4-flash", thinking: "low" });
    const stored = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME, "config.json"), "utf8"));
    expect(stored).toMatchObject({ model: "deepseek/deepseek-v4-flash", thinking: "low" });
  });

  it("keeps authoritative levels when the runtime omits capability metadata", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    // Custom provider with an explicit per-model hint (the authoritative set).
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({
      model: "custom-local-provider/local-model",
      custom_providers: [{ id: "local-provider", name: "Local Provider", base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", models: ["local-model"], reasoning: true, context_window: 64000, model_hints: { "local-model": { reasoning: true, thinking_levels: ["off", "high", "xhigh"] } } }],
    }), "utf8");
    // The runtime lists the model with reasoning but WITHOUT a thinkingLevelMap
    // (no capability metadata): it must not invent levels or erase the hint.
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [{ provider: "custom-local-provider", id: "local-model", name: "Local Model", reasoning: true }] },
    });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    const model = settings.json().available_models.find((item: { id: string }) => item.id === "custom-local-provider/local-model");
    expect(model).toMatchObject({ reasoning: true, thinking_levels: ["off", "high", "xhigh"] });
  });

  // Requires the real pi-ai catalog (OpenCode Go provider); skipped when the runtime
  // is not installed (CI).
  it.skipIf(!piAiCatalogAvailable)("lists OpenCode Go from the pi-ai catalog: needs_key without credentials, configured after saving a key", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const app = buildApp(config());
    apps.push(app);

    const before = (await app.inject({ method: "GET", url: "/api/settings/config" })).json();
    const go = before.providers.find((provider: { id: string }) => provider.id === "opencode-go");
    expect(go).toMatchObject({
      name: expect.stringMatching(/^OpenCode (?:Zen )?Go$/),
      credential_status: "needs_key",
      has_key: false,
      enabled: false,
      auth: { kind: "api_key", api_key_supported: true, oauth_supported: false, login_supported: false },
    });
    expect(go.models.length).toBeGreaterThan(0);
    // No credentials -> no Go models in the selectable catalog.
    expect(before.available_models.some((model: { provider: string }) => model.provider === "opencode-go")).toBe(false);

    const saved = await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "opencode-go", api_key: "oc-go-secret" } });
    expect(saved.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/api/settings/config" })).json();
    expect(after.providers.find((provider: { id: string }) => provider.id === "opencode-go")).toMatchObject({ credential_status: "configured", has_key: true, enabled: true });
    expect(after.api_keys).toMatchObject({ "opencode-go": true });
    // Stored key + pi-ai fallback catalog -> Go models become selectable.
    expect(after.available_models.some((model: { provider: string }) => model.provider === "opencode-go")).toBe(true);
    expect(after.body ?? after).not.toContain("oc-go-secret");
  });

  // Requires the real pi-ai catalog (OpenAI Codex); skipped when the runtime
  // is not installed (CI).
  it.skipIf(!piAiCatalogAvailable)("rejects API keys for OAuth-only and unknown providers", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const app = buildApp(config());
    apps.push(app);

    const oauthOnly = await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "openai-codex", api_key: "nope" } });
    expect(oauthOnly.statusCode).toBe(400);
    expect(oauthOnly.json()).toMatchObject({ code: "provider_requires_login" });
    expect(oauthOnly.body).not.toContain("nope");

    const unknown = await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "no-such-provider", api_key: "x" } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain("Unknown provider");

    // OAuth-only providers appear in the inventory without a has_key.
    const settings = (await app.inject({ method: "GET", url: "/api/settings/config" })).json();
    const codex = settings.providers.find((provider: { id: string }) => provider.id === "openai-codex");
    expect(codex).toMatchObject({ auth: { kind: "oauth" }, has_key: false, credential_status: "needs_login" });
  });

  it("treats an empty Orbit model listing as authoritative (no fallback mixing)", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({ success: true, data: { models: [] } });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService });
    apps.push(app);
    // A stored OpenAI key would make the pi-ai fallback list OpenAI models;
    // an empty Orbit listing must still win.
    await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "openai", api_key: "sk-test" } });
    const settings = (await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` })).json();
    expect(settings.model_catalog_source).toBe("pi");
    expect(settings.available_models.filter((model: { custom: boolean }) => !model.custom)).toHaveLength(0);
  });

  // Requires the real pi-ai catalog (OpenAI Codex auth metadata); skipped
  // when the runtime is not installed (CI).
  it.skipIf(!piAiCatalogAvailable)("keeps Orbit-listed providers (even unknown to pi-ai) in the inventory and catalog", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValue({
      success: true,
      data: { models: [{ provider: "openai-codex", id: "gpt-5.1-codex", name: "GPT-5.1 Codex", reasoning: true }] },
    });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService });
    apps.push(app);
    const settings = (await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` })).json();
    // OAuth-only + present in the live Orbit listing -> connected, usable.
    expect(settings.providers.find((provider: { id: string }) => provider.id === "openai-codex")).toMatchObject({
      credential_status: "connected",
      enabled: true,
      has_key: false,
      models: ["gpt-5.1-codex"],
    });
    expect(settings.available_models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai-codex/gpt-5.1-codex", reasoning: true }),
    ]));
  });

  // Requires the real pi-ai catalog (DeepSeek fallback hints); skipped when
  // the runtime is not installed (CI).
  it.skipIf(!piAiCatalogAvailable)("exposes reasoning levels for DeepSeek V4 fallback models", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    process.env.DEEPSEEK_API_KEY = "test-key";
    const app = buildApp(config());
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/settings/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json().available_models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek/deepseek-v4-pro", reasoning: true, thinking_levels: expect.arrayContaining(["off", "high"]), context_window: 1_000_000 }),
      expect.objectContaining({ id: "deepseek/deepseek-v4-flash", reasoning: true, thinking_levels: expect.arrayContaining(["off", "high"]), context_window: 1_000_000 }),
    ]));
  });

  it("stores compute connection settings without persisting passwords", async () => {
    const cwd = await workspace();
    const app = buildApp(config());
    apps.push(app);

    const saved = await app.inject({
      method: "POST",
      url: `/api/compute/machines?cwd=${encodeURIComponent(cwd)}`,
      payload: { label: "cluster", host: "compute.example.org", user: "researcher", auth_method: "password", password: "do-not-save" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().machines).toEqual([
      expect.objectContaining({ label: "cluster", host: "compute.example.org", port: 22, auth_method: "password", identity_file: "~/.ssh/id_rsa" }),
    ]);
    expect(saved.body).not.toContain("do-not-save");
    expect(await readFile(join(cwd, ".pi-science", "compute.json"), "utf8")).not.toContain("do-not-save");

    const invalidPort = await app.inject({
      method: "POST",
      url: `/api/compute/machines?cwd=${encodeURIComponent(cwd)}`,
      payload: { host: "compute.example.org", port: 70_000 },
    });
    expect(invalidPort.statusCode).toBe(400);

    const invalidProbe = await app.inject({
      method: "POST",
      url: `/api/compute/probe?cwd=${encodeURIComponent(cwd)}`,
      payload: { host: "-invalid" },
    });
    expect(invalidProbe.statusCode).toBe(200);
    expect(invalidProbe.json()).toMatchObject({ reachable: false, error: "Invalid SSH hostname" });
  });

  it("reports the number of valid sessions on workspace cards", async () => {
    const root = join(tmpdir(), `pi-science-workspaces-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cwd = join(root, "counted-workspace");
    tempDirs.push(root);
    process.env.PI_SCIENCE_WORKSPACES = root;
    // The workspace listing also includes pinned paths from the control home,
    // so an unisolated home leaks the developer's own pinned workspaces here.
    const home = `${root}-home`;
    tempDirs.push(home);
    process.env.PI_SCIENCE_HOME = home;
    await mkdir(join(cwd, ".pi-science", "sessions", "nested"), { recursive: true });
    await writeFile(join(cwd, ".pi-science", "sessions", "one.jsonl"), `${JSON.stringify({ type: "session", id: "one", cwd, timestamp: "2026-07-24T00:00:00.000Z" })}\n`, "utf8");
    await writeFile(join(cwd, ".pi-science", "sessions", "nested", "two.jsonl"), `${JSON.stringify({ type: "session", id: "two", cwd, timestamp: "2026-07-24T01:00:00.000Z" })}\n`, "utf8");
    await writeFile(join(cwd, ".pi-science", "sessions", "invalid.jsonl"), "not a session\n", "utf8");

    const app = buildApp(config());
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/workspaces" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ name: "counted-workspace", path: cwd, project_id: expect.stringMatching(/^project_/), session_count: 2 }),
    ]);
    expect(response.json()[0].last_modified).not.toBe("");
    const project = JSON.parse(await readFile(join(cwd, ".pi-science", "project.json"), "utf8")) as { id?: string; name?: string };
    expect(project).toMatchObject({ id: response.json()[0].project_id, name: "counted-workspace" });
  });

  it("persists an external workspace registration for discovery after restart", async () => {
    const sandbox = join(tmpdir(), `pi-science-external-registration-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const managed = join(sandbox, "managed");
    const external = join(sandbox, "external-project");
    const home = join(sandbox, "home");
    tempDirs.push(sandbox);
    await mkdir(external, { recursive: true });
    process.env.PI_SCIENCE_WORKSPACES = managed;
    process.env.PI_SCIENCE_HOME = home;

    const app = buildApp(config());
    apps.push(app);
    const opened = await app.inject({ method: "POST", url: "/api/workspaces/open", payload: { path: external } });
    const canonicalExternal = await realpath(external);

    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ path: canonicalExternal, project_id: expect.stringMatching(/^project_/) });
    expect(JSON.parse(await readFile(join(home, "registered-workspaces.json"), "utf8"))).toEqual([canonicalExternal]);

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restarted = buildApp(config());
    apps.push(restarted);
    const listed = await restarted.inject({ method: "GET", url: "/api/workspaces" });
    expect(listed.json()).toEqual([
      expect.objectContaining({ path: canonicalExternal, project_id: opened.json().project_id }),
    ]);
  });

  it("installs a demo workspace from the shipped assets and reuses it on a repeat install", async () => {
    const root = join(tmpdir(), `pi-science-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(root);
    process.env.PI_SCIENCE_WORKSPACES = root;
    const home = `${root}-home`; tempDirs.push(home); process.env.PI_SCIENCE_HOME = home;
    const app = buildApp(config());
    apps.push(app);

    const installed = await app.inject({ method: "POST", url: "/api/workspaces/demo?name=molecules" });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ name: "Molecular Playground", path: join(root, "Molecular Playground"), session_count: 0 });
    const path = installed.json().path as string;
    expect((await stat(join(path, ".pi-science"))).isDirectory()).toBe(true);
    expect((await stat(join(path, "data", "1LYS.pdb"))).isFile()).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/workspaces" })).json()).toEqual([
      expect.objectContaining({ name: "Molecular Playground" }),
    ]);

    // A repeat click opens the existing workspace; user edits are never overwritten.
    await writeFile(join(path, "data", "1LYS.pdb"), "edited by the user", "utf8");
    const again = await app.inject({ method: "POST", url: "/api/workspaces/demo?name=molecules" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ path });
    await expect(readFile(join(path, "data", "1LYS.pdb"), "utf8")).resolves.toBe("edited by the user");

    const climate = await app.inject({ method: "POST", url: "/api/workspaces/demo?name=climate" });
    expect(climate.statusCode).toBe(200);
    expect(climate.json()).toMatchObject({ name: "Climate Trends" });
    expect((await stat(join(root, "Climate Trends", "monthly_global_anomalies.csv"))).isFile()).toBe(true);
  });

  it("rejects a demo name that is not on the allowlist", async () => {
    const root = join(tmpdir(), `pi-science-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(root);
    process.env.PI_SCIENCE_WORKSPACES = root;
    const app = buildApp(config());
    apps.push(app);

    for (const name of ["", "unknown", "../../etc", "..%2F..%2Fetc", "molecular-playground"]) {
      const response = await app.inject({ method: "POST", url: `/api/workspaces/demo?name=${encodeURIComponent(name)}` });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Unknown demo");
    }
    await expect(stat(root)).rejects.toThrow();
  });

  // Requires the real pi-ai catalog (provider-scoped api-key storage);
  // skipped when the runtime is not installed (CI).
  it.skipIf(!piAiCatalogAvailable)("persists jobs, artifacts, provenance, and redacts settings secrets", async () => {
    const cwd = await workspace();
    const home = join(cwd, "control-home"); process.env.PI_SCIENCE_HOME = home;
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const key = await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "openai", api_key: "secret-value" } });
    expect(key.statusCode).toBe(200);
    const settings = await app.inject({ method: "GET", url: "/api/settings/config" });
    expect(settings.json()).toMatchObject({ api_keys: { openai: true } });
    expect(settings.body).not.toContain("secret-value");

    const custom = await app.inject({
      method: "PUT",
      url: "/api/settings/custom-providers/smoke-provider",
      payload: { name: "Smoke Provider", base_url: "https://llm.example.com/v1", api_key: "custom-secret", api: "openai-completions", models: ["smoke-model"] },
    });
    expect(custom.statusCode).toBe(200);
    expect(custom.body).not.toContain("custom-secret");
    expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json().available_models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "custom-smoke-provider/smoke-model" }),
    ]));
    expect((await app.inject({ method: "DELETE", url: "/api/settings/custom-providers/smoke-provider" })).statusCode).toBe(200);

    const job = await app.inject({ method: "POST", url: `/api/jobs?cwd=${encodeURIComponent(cwd)}`, payload: { command: [process.execPath, "-e", "process.stdout.write('smoke-job')"] } });
    expect(job.statusCode).toBe(200);
    const jobId = job.json().job_id as string;
    let final = job.json();
    for (let attempt = 0; attempt < 20 && ["pending", "running"].includes(final.status); attempt++) { await new Promise((resolve) => setTimeout(resolve, 20)); final = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}?cwd=${encodeURIComponent(cwd)}` })).json(); }
    expect(final.status).toBe("succeeded");
    expect(final.stdout).toBe("smoke-job");

    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(cwd, "result.txt"), "artifact", "utf8"));
    const artifact = await app.inject({ method: "POST", url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`, payload: { path: "result.txt", session_id: "s1" } });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.json()).toMatchObject({ path: "result.txt", version: 1 });
    const provenance = await app.inject({ method: "GET", url: `/api/provenance?cwd=${encodeURIComponent(cwd)}` });
    expect(provenance.json().records.length).toBeGreaterThan(0);
  }, 20_000);

  it("enforces workspace deletion containment at the HTTP boundary", async () => {
    const sandbox = join(tmpdir(), `pi-science-delete-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const managed = join(sandbox, "managed");
    const child = join(managed, "child");
    const sibling = join(sandbox, "managed-evil");
    tempDirs.push(sandbox);
    await mkdir(join(child, ".pi-science"), { recursive: true });
    await mkdir(sibling, { recursive: true });
    process.env.PI_SCIENCE_WORKSPACES = managed;
    const app = buildApp(config()); apps.push(app);

    const rootResponse = await app.inject({ method: "DELETE", url: "/api/workspaces/delete", payload: { path: managed } });
    const siblingResponse = await app.inject({ method: "DELETE", url: "/api/workspaces/delete", payload: { path: sibling } });
    const childResponse = await app.inject({ method: "DELETE", url: "/api/workspaces/delete", payload: { path: child } });

    expect(rootResponse.statusCode).toBe(403);
    expect(siblingResponse.statusCode).toBe(403);
    expect(childResponse.statusCode).toBe(200);
    await expect(stat(sibling)).resolves.toBeDefined();
    await expect(stat(child)).rejects.toThrow();
  });

  it("rejects nested and unmarked paths as managed workspace identities", async () => {
    const sandbox = join(tmpdir(), `pi-science-nested-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const managed = join(sandbox, "managed");
    const parent = join(managed, "parent");
    const nested = join(parent, "nested");
    const unmarked = join(managed, "unmarked");
    tempDirs.push(sandbox);
    await mkdir(join(parent, ".pi-science"), { recursive: true });
    await mkdir(join(nested, ".pi-science"), { recursive: true });
    await mkdir(unmarked, { recursive: true });
    process.env.PI_SCIENCE_WORKSPACES = managed;
    const canonicalParent = await realpath(parent);
    const modules = createServerModules(config());
    const active = vi.spyOn(modules.jobs, "hasActive").mockImplementation(async (path) => path === canonicalParent);
    const app = buildApp(config(), modules); apps.push(app);

    const nestedDelete = await app.inject({ method: "DELETE", url: "/api/workspaces/delete", payload: { path: nested } });
    const nestedRename = await app.inject({ method: "POST", url: "/api/workspaces/rename", payload: { path: nested, name: "renamed" } });
    const unmarkedDelete = await app.inject({ method: "DELETE", url: "/api/workspaces/delete", payload: { path: unmarked } });
    const parentDelete = await app.inject({ method: "DELETE", url: "/api/workspaces/delete", payload: { path: parent } });

    expect(nestedDelete.statusCode).toBe(403);
    expect(nestedRename.statusCode).toBe(403);
    expect(unmarkedDelete.statusCode).toBe(403);
    expect(parentDelete.statusCode).toBe(409);
    expect(active).toHaveBeenCalledWith(canonicalParent);
    await expect(stat(nested)).resolves.toBeDefined();
    await expect(stat(unmarked)).resolves.toBeDefined();
  });

  it("updates a pin stored through a symlinked managed root after rename", async () => {
    const sandbox = join(tmpdir(), `pi-science-pinned-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const managed = join(sandbox, "managed");
    const alias = join(sandbox, "managed-alias");
    const source = join(managed, "source");
    const home = join(sandbox, "home");
    tempDirs.push(sandbox);
    await mkdir(join(source, ".pi-science"), { recursive: true });
    await symlink(managed, alias, process.platform === "win32" ? "junction" : "dir");
    process.env.PI_SCIENCE_WORKSPACES = alias;
    process.env.PI_SCIENCE_HOME = home;
    const app = buildApp(config()); apps.push(app);
    const requestedSource = join(alias, "source");

    expect((await app.inject({ method: "POST", url: "/api/workspaces/pin", payload: { path: requestedSource } })).statusCode).toBe(200);
    const renamed = await app.inject({ method: "POST", url: "/api/workspaces/rename", payload: { path: requestedSource, name: "renamed" } });

    expect(renamed.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/workspaces/pinned" })).json()).toEqual({ paths: [join(alias, "renamed")] });
    await expect(stat(join(managed, "renamed", ".pi-science"))).resolves.toBeDefined();
  });

  it("rejects workspace deletion through a symlink or junction before recursive removal", async () => {
    const sandbox = join(tmpdir(), `pi-science-delete-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const managed = join(sandbox, "managed");
    const outside = join(sandbox, "outside");
    const outsideWorkspace = join(outside, "workspace");
    const escape = join(managed, "escape");
    tempDirs.push(sandbox);
    await mkdir(join(outsideWorkspace, ".pi-science"), { recursive: true });
    await writeFile(join(outsideWorkspace, "keep.txt"), "outside", "utf8");
    await mkdir(managed, { recursive: true });
    await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
    process.env.PI_SCIENCE_WORKSPACES = managed;
    const app = buildApp(config()); apps.push(app);

    const response = await app.inject({ method: "DELETE", url: "/api/workspaces/delete", payload: { path: join(escape, "workspace") } });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/symlink|junction/);
    await expect(readFile(join(outsideWorkspace, "keep.txt"), "utf8")).resolves.toBe("outside");
  });

  it("rejects workspace rename through a symlink or junction", async () => {
    const sandbox = join(tmpdir(), `pi-science-rename-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const managed = join(sandbox, "managed");
    const outside = join(sandbox, "outside");
    const outsideWorkspace = join(outside, "workspace");
    const escape = join(managed, "escape");
    tempDirs.push(sandbox);
    await mkdir(join(outsideWorkspace, ".pi-science"), { recursive: true });
    await writeFile(join(outsideWorkspace, "keep.txt"), "outside", "utf8");
    await mkdir(managed, { recursive: true });
    await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
    process.env.PI_SCIENCE_WORKSPACES = managed;
    const app = buildApp(config()); apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/workspaces/rename", payload: { path: join(escape, "workspace"), name: "renamed" } });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/symlink|junction/);
    await expect(readFile(join(outsideWorkspace, "keep.txt"), "utf8")).resolves.toBe("outside");
    await expect(stat(join(outside, "renamed"))).rejects.toThrow();
  });

  it("uses platform path semantics for nested file moves, probes, and previews", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    await writeFile(join(cwd, "source.txt"), "hello", "utf8");
    const target = join(cwd, "nested", "renamed.txt");

    const moved = await app.inject({ method: "POST", url: `/api/files/rename?cwd=${encodeURIComponent(cwd)}`, payload: { source: "source.txt", target: "nested/renamed.txt" } });
    expect(moved.statusCode).toBe(200);
    await expect(readFile(target, "utf8")).resolves.toBe("hello");
    await expect(stat(target.slice(0, -1))).rejects.toThrow();

    const listed = await app.inject({ method: "GET", url: `/api/files?cwd=${encodeURIComponent(cwd)}&subdir=${encodeURIComponent("nested")}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ path: "nested/renamed.txt", name: "renamed.txt" })]);

    const probe = await app.inject({ method: "GET", url: `/api/files/probe/nested/renamed.txt?cwd=${encodeURIComponent(cwd)}` });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ path: "nested/renamed.txt", name: "renamed.txt", is_dir: false });

    const preview = await app.inject({ method: "GET", url: `/api/files/nested/renamed.txt/preview?cwd=${encodeURIComponent(cwd)}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ path: "nested/renamed.txt", name: "renamed.txt", extension: ".txt" });

    // The browser used to encode the whole nested path as one wildcard
    // segment (`nested%2Frenamed.txt`). Keep this contract working while the
    // frontend uses segment-wise encoding for new requests.
    const encodedRead = await app.inject({ method: "GET", url: `/api/files/${encodeURIComponent("nested/renamed.txt")}?cwd=${encodeURIComponent(cwd)}` });
    expect(encodedRead.statusCode).toBe(200);
    expect(encodedRead.json()).toMatchObject({ path: "nested/renamed.txt", data: "hello" });
  });

  it("reads a capped byte window with maxBytes and validates the parameter", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    await writeFile(join(cwd, "snippet.txt"), "abcdefghijklmnopqrstuvwxyz0123456789", "utf8");

    const capped = await app.inject({ method: "GET", url: `/api/files/snippet.txt?cwd=${encodeURIComponent(cwd)}&maxBytes=10` });
    expect(capped.statusCode).toBe(200);
    expect(capped.json()).toMatchObject({ path: "snippet.txt", data: "abcdefghij", size: 10, truncated: true });

    // Keep a capped UTF-8 preview valid when the byte limit lands inside a
    // multi-byte CJK character; otherwise the frontend would mistake it for
    // binary text and refuse to render the Markdown preview.
    await writeFile(join(cwd, "unicode.txt"), "你好世界", "utf8");
    const unicode = await app.inject({ method: "GET", url: `/api/files/unicode.txt?cwd=${encodeURIComponent(cwd)}&maxBytes=4` });
    expect(unicode.statusCode).toBe(200);
    expect(unicode.json()).toMatchObject({ data: "你好", truncated: true });

    const full = await app.inject({ method: "GET", url: `/api/files/snippet.txt?cwd=${encodeURIComponent(cwd)}` });
    expect(full.statusCode).toBe(200);
    expect(full.json()).toMatchObject({ data: "abcdefghijklmnopqrstuvwxyz0123456789", size: 36 });
    expect(full.json()).not.toHaveProperty("truncated");

    // Cap larger than the file: reads everything, no truncated flag.
    const oversized = await app.inject({ method: "GET", url: `/api/files/snippet.txt?cwd=${encodeURIComponent(cwd)}&maxBytes=500` });
    expect(oversized.statusCode).toBe(200);
    expect(oversized.json()).toMatchObject({ data: "abcdefghijklmnopqrstuvwxyz0123456789", size: 36 });
    expect(oversized.json()).not.toHaveProperty("truncated");

    const invalid = await app.inject({ method: "GET", url: `/api/files/snippet.txt?cwd=${encodeURIComponent(cwd)}&maxBytes=abc` });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "maxBytes must be a positive integer" });

    const zero = await app.inject({ method: "GET", url: `/api/files/snippet.txt?cwd=${encodeURIComponent(cwd)}&maxBytes=0` });
    expect(zero.statusCode).toBe(400);
  });

  it("normalizes backslash-form file requests and provenance to API paths", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    const uploaded = await app.inject({ method: "POST", url: `/api/files/upload?cwd=${encodeURIComponent(cwd)}`, payload: { path: "incoming\\nested.txt", content: "hello" } });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({ path: "incoming/nested.txt", filename: "nested.txt" });

    const moved = await app.inject({ method: "POST", url: `/api/files/move?cwd=${encodeURIComponent(cwd)}`, payload: { source: "incoming\\nested.txt", target: "results\\renamed.txt" } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ source: "incoming/nested.txt", target: "results/renamed.txt" });

    const requested = encodeURIComponent("results\\renamed.txt");
    const probe = await app.inject({ method: "GET", url: `/api/files/probe/${requested}?cwd=${encodeURIComponent(cwd)}` });
    const preview = await app.inject({ method: "GET", url: `/api/files/${encodeURIComponent("results\\renamed.txt\\preview")}?cwd=${encodeURIComponent(cwd)}` });
    const read = await app.inject({ method: "GET", url: `/api/files/${requested}?cwd=${encodeURIComponent(cwd)}` });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ path: "results/renamed.txt", name: "renamed.txt" });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ path: "results/renamed.txt", name: "renamed.txt" });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ path: "results/renamed.txt", data: "hello" });

    const provenance = (await readFile(join(cwd, ".pi-science", "provenance.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { path: string; diff?: string });
    expect(provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "incoming/nested.txt" }),
      expect.objectContaining({ path: "results/renamed.txt", diff: "incoming/nested.txt -> results/renamed.txt" }),
    ]));
  });

  it("supports atomic file writes and research-loop state transitions", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    const upload = await app.inject({ method: "POST", url: `/api/files/upload?cwd=${encodeURIComponent(cwd)}`, payload: { filename: "uploaded.txt", content: "hello" } });
    expect(upload.statusCode).toBe(200);
    const move = await app.inject({ method: "POST", url: `/api/files/rename?cwd=${encodeURIComponent(cwd)}`, payload: { source: "uploaded.txt", target: "renamed.txt" } });
    expect(move.statusCode).toBe(200);
    expect(await readFile(join(cwd, "renamed.txt"), "utf8")).toBe("hello");
    const remove = await app.inject({ method: "DELETE", url: `/api/files/renamed.txt?cwd=${encodeURIComponent(cwd)}` });
    expect(remove.statusCode).toBe(200);
    await expect(stat(join(cwd, "renamed.txt"))).rejects.toThrow();

    const loop = await app.inject({ method: "POST", url: `/api/project-memory/research-loops?cwd=${encodeURIComponent(cwd)}`, payload: { title: "Smoke loop", objective: "Verify state", task_type: "optimize" } });
    expect(loop.statusCode).toBe(200);
    const loopId = loop.json().loop_id as string;
    expect((await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/start?cwd=${encodeURIComponent(cwd)}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/project-memory/research-loops/${loopId}/cancel?cwd=${encodeURIComponent(cwd)}` })).statusCode).toBe(200);
    const listed = await app.inject({ method: "GET", url: `/api/project-memory/research-loops?cwd=${encodeURIComponent(cwd)}` });
    expect(listed.json().loops[0]).toMatchObject({ loop_id: loopId, status: "cancelled", task_type: "optimize" });
  });

  it("compiles conversation research modes into distinct execution plans", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);

    const optimize = await app.inject({ method: "POST", url: `/api/project-memory/research-loop-intents?cwd=${encodeURIComponent(cwd)}`, payload: { mode: "optimize", objective: "Minimize model latency" } });
    expect(optimize.statusCode).toBe(200);
    expect(optimize.json()).toMatchObject({
      requires_confirmation: true,
      missing_fields: [],
      draft: { task_type: "optimize", execution_kind: "iterative", metric: "latency", direction: "minimize", conversation_prompt: null },
    });

    const naturalLanguage = await app.inject({ method: "POST", url: `/api/project-memory/research-loop-intents?cwd=${encodeURIComponent(cwd)}`, payload: { mode: "optimize", objective: "降低模型首 token 时间，同时保持回答质量" } });
    expect(naturalLanguage.statusCode).toBe(200);
    expect(naturalLanguage.json()).toMatchObject({
      requires_confirmation: true,
      missing_fields: [],
      draft: { metric: "time_to_first_token", direction: "minimize" },
    });
    expect(naturalLanguage.json().draft.success_criterion).toContain("降低");
    expect(naturalLanguage.json().draft.plan_steps).toHaveLength(3);

    const exploratory = await app.inject({ method: "POST", url: `/api/project-memory/research-loop-intents?cwd=${encodeURIComponent(cwd)}`, payload: { mode: "research_loop", objective: "探索这种材料为什么在潮湿环境中失效" } });
    expect(exploratory.statusCode).toBe(200);
    expect(exploratory.json()).toMatchObject({
      requires_confirmation: true,
      missing_fields: [],
      draft: { metric: "evidence_quality", direction: "maximize" },
    });

    const compare = await app.inject({ method: "POST", url: `/api/project-memory/research-loop-intents?cwd=${encodeURIComponent(cwd)}`, payload: { mode: "compare", objective: "Compare method A with method B" } });
    expect(compare.statusCode).toBe(200);
    expect(compare.json()).toMatchObject({ requires_confirmation: false, draft: { task_type: "compare", execution_kind: "conversation" } });
    expect(compare.json().draft.conversation_prompt).toContain("[Workflow: compare]");
    expect(compare.json().draft.conversation_prompt).toContain("comparison table");

    const invalid = await app.inject({ method: "POST", url: `/api/project-memory/research-loop-intents?cwd=${encodeURIComponent(cwd)}`, payload: { mode: "unknown", objective: "Anything" } });
    expect(invalid.statusCode).toBe(400);
  });

  it("streams research record invalidation events over SSE", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/project-memory/research-events?cwd=${encodeURIComponent(cwd)}`, payloadAsStream: true });
    try {
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream");
      let text = ""; let notify: (() => void) | null = null;
      response.stream().on("data", (chunk: Buffer) => { text += String(chunk); notify?.(); });
      const readUntil = async (marker: string) => {
        const deadline = Date.now() + 8_000;
        while (!text.includes(marker)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(marker)}; received: ${JSON.stringify(text)}`);
          await new Promise<void>((resolve) => { notify = resolve; setTimeout(resolve, 50); });
        }
        return text;
      };
      await readUntil(": connected\n\n");
      // The route subscribes under the realpath'd workspace (validateWorkspaceCwd),
      // so emit through a repository keyed the same way.
      await new ResearchRepository(await realpath(cwd)).append("loop.created", { title: "SSE smoke" }, { loop_id: "loop-sse" });
      const received = await readUntil("research.record");
      expect(received).toContain(`data: ${JSON.stringify({ type: "research.record", loop_id: "loop-sse", record_type: "loop.created" })}\n\n`);
    } finally {
      response.raw.res.destroy();
    }
  }, 15_000);

  it("preserves exact multipart upload bytes and supports nested destination paths", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    const boundary = "----pi-science-upload-boundary";
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="uploaded.txt"',
        "Content-Type: text/plain",
        "",
        "hello",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
      "utf8",
    );
    const upload = await app.inject({
      method: "POST",
      url: `/api/files/upload?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("data/nested/uploaded.txt")}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(upload.statusCode).toBe(200);
    expect(await readFile(join(cwd, "data", "nested", "uploaded.txt"), "utf8")).toBe("hello");
  });

  it("validates the requested skill directory instead of always scanning project skills", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    await mkdir(join(cwd, ".pi", "skills", "good"), { recursive: true });
    await writeFile(join(cwd, ".pi", "skills", "good", "SKILL.md"), "---\nname: good\ndescription: Good skill\n---\n", "utf8");
    await mkdir(join(cwd, "tmp-skill"), { recursive: true });
    await writeFile(join(cwd, "tmp-skill", "SKILL.md"), "not front matter", "utf8");
    const response = await app.inject({ method: "POST", url: `/api/skills/validate?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(join(cwd, "tmp-skill"))}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ valid: false });
    expect(response.json().validations).toHaveLength(1);
  });

  it("rejects case-insensitive metadata aliases from skill validation", async () => {
    const cwd = await workspace(); const app = buildApp(config()); apps.push(app);
    const alias = join(cwd, ".PI-SCIENCE", "skill");
    await mkdir(alias, { recursive: true });
    await writeFile(join(alias, "SKILL.md"), "---\nname: hidden\ndescription: Hidden metadata skill\n---\n", "utf8");

    const response = await app.inject({ method: "POST", url: `/api/skills/validate?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(alias)}` });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/inside the workspace/);
  });

  // Requires the real pi-ai catalog (openai/google providers); skipped when
  // the runtime is not installed (CI).
  it.skipIf(!piAiCatalogAvailable)("serializes concurrent settings updates without losing providers", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const app = buildApp(config()); apps.push(app);
    const [openai, google] = await Promise.all([
      app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "openai", api_key: "openai-secret" } }),
      app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "google", api_key: "google-secret" } }),
    ]);
    expect(openai.statusCode).toBe(200);
    expect(google.statusCode).toBe(200);
    const settings = (await app.inject({ method: "GET", url: "/api/settings/config" })).json();
    expect(settings.api_keys).toMatchObject({ openai: true, google: true });
  });

  it("exposes keyless custom providers and rejects slug collisions without blocking canonical updates", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const app = buildApp(config()); apps.push(app);
    const payload = { name: "Local Provider", base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", models: ["local-model"], reasoning: true, context_window: 64000 };
    expect((await app.inject({ method: "PUT", url: "/api/settings/custom-providers/local-provider", payload })).statusCode).toBe(200);
    const settings = (await app.inject({ method: "GET", url: "/api/settings/config" })).json();
    expect(settings.available_models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "custom-local-provider/local-model", reasoning: true, context_window: 64000, thinking_levels: ["off", "minimal", "low", "medium", "high"] }),
    ]));
    // Without explicit hints the fallback must never invent xhigh/max.
    const fallbackLevels = settings.available_models.find((item: { id: string }) => item.id === "custom-local-provider/local-model").thinking_levels;
    expect(fallbackLevels).not.toContain("xhigh");
    expect(fallbackLevels).not.toContain("max");
    const compaction = await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: true, threshold_percent: 82 } });
    expect(compaction.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json()).toMatchObject({ compaction_enabled: true, compaction_threshold_percent: 82 });
    expect((await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: true, threshold_percent: 99 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/settings/custom-providers/Local%20Provider", payload })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: "/api/settings/custom-providers/local-provider", payload: { ...payload, models: ["updated-model"] } })).statusCode).toBe(200);
  });

  it("preserves inline and per-model metadata from custom provider discovery", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [
        { id: "inline-model", max_model_len: 800_000, reasoning: true, thinking_levels: ["off", "high"] },
        { id: "detail-model" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/models/detail-model")) return new Response(JSON.stringify({ id: "detail-model", context_window: 262_144, supports_reasoning: false }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected discovery request: ${url}`);
    });
    const app = buildApp(config()); apps.push(app);

    const discovered = await app.inject({
      method: "POST",
      url: "/api/settings/custom-providers/discover",
      payload: { name: "Metadata API", base_url: "http://127.0.0.1:30002/v1", api_key: "secret", api: "openai-completions" },
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json().provider).toMatchObject({
      models: ["inline-model", "detail-model"],
      model_hints: {
        "inline-model": { context_window: 800_000, reasoning: true, thinking_levels: ["off", "high"], source: "models" },
        "detail-model": { context_window: 262_144, reasoning: false, source: "model-detail" },
      },
    });

    const provider = discovered.json().provider;
    const saved = await app.inject({ method: "PUT", url: `/api/settings/custom-providers/${provider.id}`, payload: { ...provider, api_key: "secret", reasoning: true, context_window: 128_000 } });
    expect(saved.statusCode).toBe(200);
    expect(requests).toHaveLength(2);
    const settings = (await app.inject({ method: "GET", url: "/api/settings/config" })).json();
    expect(settings.available_models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "custom-metadata-api/inline-model", context_window: 800_000, reasoning: true }),
      expect.objectContaining({ id: "custom-metadata-api/detail-model", context_window: 262_144, reasoning: false }),
    ]));
  });

  it("allows a slower direct-save capability probe without falling back to 128K", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.endsWith("/models")) throw new Error(`unexpected slow probe request: ${url}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 900);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
      });
      return new Response(JSON.stringify({ data: [{ id: "slow-model", max_model_len: 524_288, reasoning: true }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const app = buildApp(config()); apps.push(app);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings/custom-providers/slow-provider",
      payload: { name: "Slow Provider", base_url: "http://127.0.0.1:30003/v1", api: "openai-completions", models: ["slow-model"], context_window: 128_000, model_hints: { "slow-model": { reasoning: false, source: "manual" } } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().provider.model_hints["slow-model"]).toMatchObject({ context_window: 524_288, reasoning: false, source: "manual" });
  });

  it("probes OpenAI and Anthropic model capabilities with protocol-correct authentication", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, headers: new Headers(init?.headers), body });
      if (url.endsWith("/models")) {
        const id = url.includes("anthropic") ? "claude-private" : "openai-private";
        return new Response(JSON.stringify({ data: [{ id }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/models/")) return new Response(JSON.stringify({ error: "metadata unavailable" }), { status: 404, headers: { "content-type": "application/json" } });
      if (url.endsWith("/chat/completions")) return new Response(JSON.stringify({ error: { message: "Maximum context length is 131,072 tokens", supports_reasoning: true, thinking_levels: ["off", "medium", "high"] } }), { status: 400, headers: { "content-type": "application/json" } });
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ error: { message: "This model has a maximum context length of 200,000 tokens", supports_reasoning: true, thinking_levels: ["off", "high"] } }), { status: 400, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected probe request: ${url}`);
    });
    const app = buildApp(config()); apps.push(app);

    const openai = await app.inject({ method: "POST", url: "/api/settings/custom-providers/discover", payload: { name: "OpenAI Local", base_url: "http://127.0.0.1/openai/v1", api_key: "openai-key", api: "openai-completions" } });
    expect(openai.statusCode).toBe(200);
    expect(openai.json().provider.model_hints["openai-private"]).toMatchObject({ context_window: 131_072, reasoning: true, thinking_levels: ["off", "medium", "high"], source: "openai-chat-probe" });

    const anthropic = await app.inject({ method: "POST", url: "/api/settings/custom-providers/discover", payload: { name: "Anthropic Local", base_url: "http://127.0.0.1/anthropic/v1", api_key: "anthropic-key", api: "anthropic-messages" } });
    expect(anthropic.statusCode).toBe(200);
    expect(anthropic.json().provider.model_hints["claude-private"]).toMatchObject({ context_window: 200_000, reasoning: true, thinking_levels: ["off", "high"], source: "anthropic-probe" });

    const openaiProbe = calls.find((call) => call.url.endsWith("/chat/completions"));
    expect(openaiProbe?.headers.get("authorization")).toBe("Bearer openai-key");
    expect(openaiProbe?.body?.max_tokens).toBe(1_000_000_000);
    const anthropicList = calls.find((call) => call.url.endsWith("/anthropic/v1/models"));
    const anthropicProbe = calls.find((call) => call.url.endsWith("/messages"));
    expect(anthropicList?.headers.get("x-api-key")).toBe("anthropic-key");
    expect(anthropicList?.headers.has("authorization")).toBe(false);
    expect(anthropicProbe?.headers.get("x-api-key")).toBe("anthropic-key");
    expect(anthropicProbe?.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("probes OpenAI Responses model capabilities with the responses protocol", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url, headers: new Headers(init?.headers), body });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "responses-private" }] }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/models/")) return new Response(JSON.stringify({ error: "metadata unavailable" }), { status: 404, headers: { "content-type": "application/json" } });
      if (url.endsWith("/responses")) return new Response(JSON.stringify({ error: { message: "Maximum context length is 196,608 tokens", supports_reasoning: true, thinking_levels: ["off", "low", "max"] } }), { status: 400, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected probe request: ${url}`);
    });
    const app = buildApp(config()); apps.push(app);

    const responses = await app.inject({ method: "POST", url: "/api/settings/custom-providers/discover", payload: { name: "Responses API", base_url: "http://127.0.0.1/responses/v1", api_key: "responses-key", api: "openai-responses" } });
    expect(responses.statusCode).toBe(200);
    expect(responses.json().provider.model_hints["responses-private"]).toMatchObject({ context_window: 196_608, reasoning: true, thinking_levels: ["off", "low", "max"], source: "openai-responses-probe" });

    const list = calls.find((call) => call.url.endsWith("/responses/v1/models"));
    const probe = calls.find((call) => call.url.endsWith("/responses"));
    expect(list?.headers.get("authorization")).toBe("Bearer responses-key");
    expect(probe?.headers.get("authorization")).toBe("Bearer responses-key");
    // The responses protocol uses input + max_output_tokens (not messages/max_tokens).
    expect(probe?.body).toMatchObject({ model: "responses-private", input: "ping", max_output_tokens: 1_000_000_000 });
  });

  it("toggles compaction enabled without a threshold while keeping strict threshold validation", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    const app = buildApp(config()); apps.push(app);
    expect((await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: true, threshold_percent: 82 } })).statusCode).toBe(200);
    const disabled = await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: false } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ ok: true, compaction_enabled: false, compaction_threshold_percent: 82 });
    expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json()).toMatchObject({ compaction_enabled: false, compaction_threshold_percent: 82 });
    expect((await app.inject({ method: "PUT", url: "/api/settings/compaction", payload: { enabled: true, threshold_percent: 98 } })).statusCode).toBe(400);
  });

  it("clamps the derived compaction threshold for large context windows", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({ model: "google/gemini-2.5-pro" }), "utf8");
    vi.spyOn(nodeSessionService, "availableModels").mockResolvedValueOnce({
      success: true,
      data: { models: [{ provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, contextWindow: 1_000_000, thinkingLevelMap: {} }] },
    });
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const settings = await app.inject({ method: "GET", url: `/api/settings/config?cwd=${encodeURIComponent(cwd)}` });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ model: "google/gemini-2.5-pro", compaction_threshold_percent: 95 });
  });

  // Requires the real pi-ai catalog (openai provider); skipped when the
  // runtime is not installed (CI).
  it.skipIf(!piAiCatalogAvailable)("returns a non-ok response when persisted settings cannot reload Pi runtimes", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_HOME = join(cwd, "control-home");
    vi.spyOn(nodeSessionService, "reloadConfiguration").mockRejectedValueOnce(new Error("forced reload failure"));
    const app = buildApp(config(), { ...createServerModules(), sessions: nodeSessionService }); apps.push(app);
    const response = await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "openai", api_key: "saved-secret" } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ ok: false, error: expect.stringContaining("forced reload failure") });
    expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json().api_keys).toMatchObject({ openai: true });
  });

  it("blocks SSRF targets and validates subagent workspace access", async () => {
    const cwd = await workspace();
    process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS = "0";
    const app = buildApp(config()); apps.push(app);
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(join(cwd, ".pi", "agents", "reviewer.md"), "# reviewer", "utf8");

    const blocked = await app.inject({ method: "POST", url: "/api/settings/custom-providers/discover", payload: { base_url: "http://127.0.0.1:11434/v1", api_key: "secret" } });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body).not.toContain("secret");

    const agents = await app.inject({ method: "GET", url: `/api/settings/subagents?cwd=${encodeURIComponent(cwd)}` });
    expect(agents.statusCode).toBe(200);
    expect(agents.json()).toEqual({ agents: [{ name: "reviewer", path: ".pi/agents/reviewer.md" }] });

    await writeFile(join(cwd, ".pi", "agents", "renamed.md"), "---\nname: literature-auditor\ndescription: Checks literature sources\npackage: science-tools\n---\n", "utf8");
    await writeFile(join(cwd, ".pi", "agents", "README.md"), "# Not an agent", "utf8");

    const discovery = await app.inject({ method: "GET", url: `/api/settings/subagents/discovery?cwd=${encodeURIComponent(cwd)}` });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json().agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "science-tools.literature-auditor", description: "Checks literature sources", source: "project" }),
      expect.objectContaining({ name: "scout", source: "builtin" }),
    ]));
    expect(discovery.json().agents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "renamed" }),
      expect.objectContaining({ name: "README" }),
    ]));

    const outside = await app.inject({ method: "GET", url: "/api/settings/subagents?cwd=/tmp" });
    expect(outside.statusCode).toBe(403);
  });

  it("rejects job path traversal and preserves cancellation", async () => {
    const cwd = await workspace();
    const app = buildApp(config()); apps.push(app);
    const traversal = await app.inject({ method: "GET", url: `/api/jobs/${encodeURIComponent("../config")}?cwd=${encodeURIComponent(cwd)}` });
    expect(traversal.statusCode).toBe(400);

    const submitted = await app.inject({ method: "POST", url: `/api/jobs?cwd=${encodeURIComponent(cwd)}`, payload: { command: [process.execPath, "-e", "setTimeout(() => process.stdout.write('late'), 500)"], requirement: { timeout_seconds: 10 } } });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).not.toHaveProperty("ownership");
    const jobId = submitted.json().job_id as string;
    const listed = await app.inject({ method: "GET", url: `/api/jobs?cwd=${encodeURIComponent(cwd)}` });
    expect(listed.json().jobs[0]).not.toHaveProperty("ownership");
    const fetched = await app.inject({ method: "GET", url: `/api/jobs/${jobId}?cwd=${encodeURIComponent(cwd)}` });
    expect(fetched.json()).not.toHaveProperty("ownership");
    const cancelled = await app.inject({ method: "DELETE", url: `/api/jobs/${jobId}?cwd=${encodeURIComponent(cwd)}` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).not.toHaveProperty("ownership");
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = (await app.inject({ method: "GET", url: `/api/jobs/${jobId}?cwd=${encodeURIComponent(cwd)}` })).json();
      if (!["pending", "running"].includes(current.status)) { expect(current.status).toBe("cancelled"); expect(current).not.toHaveProperty("ownership"); return; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("cancelled job did not reach a terminal state");
  }, 20_000);

  it("rejects invalid claim-check bounds and serializes provenance versions", async () => {
    const cwd = await workspace();
    const app = buildApp(config()); apps.push(app);
    const invalid = await app.inject({ method: "POST", url: "/api/artifacts/claim-check", payload: { claim: "x", values: [1], minimum: "not-a-number" } });
    expect(invalid.statusCode).toBe(422);
    const reversed = await app.inject({ method: "POST", url: "/api/artifacts/claim-check", payload: { claim: "x", values: [1], minimum: 3, maximum: 2 } });
    expect(reversed.statusCode).toBe(422);

    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => app.inject({ method: "POST", url: `/api/provenance/record?cwd=${encodeURIComponent(cwd)}`, payload: { path: "result.txt", tool: `test-${index}` } })));
    expect(results.every((response) => response.statusCode === 200)).toBe(true);
    const versions = results.map((response) => response.json().version).sort((a: number, b: number) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
