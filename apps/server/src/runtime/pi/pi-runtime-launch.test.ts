import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPiProcessOptions, loadDefaultPiConfig, resetWebRuntimeAllocation, runtimeExtensionStatus } from "./pi-runtime-launch.js";
import { CredentialStore } from "../../model-resources/credential-store.js";
import { ModelResourceRepository, emptyModelResourceState } from "../../model-resources/model-resource-repository.js";
import { runtimeCredentialEnvName } from "../../model-resources/runtime-credential-env.js";

const cleanup: string[] = [];
const original = { home: process.env.PI_SCIENCE_HOME, userHome: process.env.HOME, userProfile: process.env.USERPROFILE, cli: process.env.PI_CLI_PATH, tsx: process.env.PI_TSX_PATH, tsconfig: process.env.PI_TSCONFIG_PATH, piMode: process.env.PI_SCIENCE_PI_MODE };

beforeEach(async () => {
  const root = join(tmpdir(), `pi-science-runtime-launch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(root);
  await mkdir(root, { recursive: true });
  process.env.PI_SCIENCE_HOME = join(root, "control-home");
  process.env.PI_CLI_PATH = join(root, "fake-pi.mjs");
  delete process.env.PI_SCIENCE_PI_MODE;
  // The shared port/token singleton must not leak across tests.
  resetWebRuntimeAllocation();
});

afterEach(async () => {
  process.env.PI_SCIENCE_HOME = original.home;
  if (original.userHome === undefined) delete process.env.HOME;
  else process.env.HOME = original.userHome;
  if (original.userProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = original.userProfile;
  process.env.PI_CLI_PATH = original.cli;
  process.env.PI_TSX_PATH = original.tsx;
  process.env.PI_TSCONFIG_PATH = original.tsconfig;
  if (original.piMode === undefined) delete process.env.PI_SCIENCE_PI_MODE;
  else process.env.PI_SCIENCE_PI_MODE = original.piMode;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function obstructModelsFile(customProviders?: unknown[]): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-runtime-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(cwd, { recursive: true });
  const agentDir = join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host");
  await mkdir(join(agentDir, "models.json"), { recursive: true });
  await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
  await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({ custom_providers: customProviders ?? [] })}\n`, "utf8");
  return cwd;
}

describe("Pi runtime custom provider materialization", () => {
  it("infers DeepSeek V4 custom models as reasoning-capable", async () => {
    const cwd = join(tmpdir(), `pi-runtime-deepseek-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({
      custom_providers: [{ id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com", api: "openai-completions", models: ["deepseek-v4-flash"] }],
    })}\n`, "utf8");

    buildPiProcessOptions(cwd);

    const catalog = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "models.json"), "utf8"));
    expect(catalog.providers["custom-deepseek"].api).toBe("openai-completions");
    expect(catalog.providers["custom-deepseek"].models[0]).toMatchObject({
      id: "deepseek-v4-flash",
      reasoning: true,
      thinkingLevelMap: expect.objectContaining({ low: "low", high: "high", xhigh: "xhigh" }),
    });
  });

  it("materializes openai-responses and anthropic-messages providers with per-model hints", async () => {
    const cwd = join(tmpdir(), `pi-runtime-three-api-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({
      custom_providers: [
        { id: "responses", name: "Responses API", base_url: "https://responses.example.com/v1", api: "openai-responses", models: ["resp-model"], reasoning: false, context_window: 64000, model_hints: { "resp-model": { context_window: 262144, reasoning: true, thinking_levels: ["off", "medium", "high"] } } },
        { id: "claude", name: "Claude Gateway", base_url: "https://claude.example.com/v1", api: "anthropic-messages", models: ["claude-model"], model_hints: { "claude-model": { context_window: 200000, reasoning: true, thinking_levels: ["off", "high"] } } },
      ],
    })}\n`, "utf8");

    buildPiProcessOptions(cwd);

    const catalog = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "models.json"), "utf8"));
    // The API format is passed through exactly for every protocol.
    expect(catalog.providers["custom-responses"].api).toBe("openai-responses");
    expect(catalog.providers["custom-claude"].api).toBe("anthropic-messages");
    // Per-model hints win over the provider-level reasoning default (false)
    // and map into contextWindow / reasoning / thinkingLevelMap.
    expect(catalog.providers["custom-responses"].models[0]).toMatchObject({
      id: "resp-model", reasoning: true, contextWindow: 262144,
      thinkingLevelMap: { off: "off", medium: "medium", high: "high" },
    });
    expect(catalog.providers["custom-claude"].models[0]).toMatchObject({
      id: "claude-model", reasoning: true, contextWindow: 200000,
      thinkingLevelMap: { off: "off", high: "high" },
    });
  });

  it("writes stored API keys for any pi-ai provider (OpenCode Go) into auth.json with 0600 permissions", async () => {
    const cwd = join(tmpdir(), `pi-runtime-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({ api_keys: { "opencode-go": "oc-go-secret" } })}\n`, "utf8");

    buildPiProcessOptions(cwd);

    const auth = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "auth.json"), "utf8"));
    expect(auth["opencode-go"]).toEqual({ type: "api_key", key: "oc-go-secret" });
    const mode = (await stat(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "auth.json"))).mode & 0o777;
    // Windows has no POSIX mode bits (chmod is best-effort there); the content
    // assertions above still validate the materialization on every platform.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("preserves non-api-key auth entries, merges Pi-Science keys, and drops stale managed keys", async () => {
    const cwd = join(tmpdir(), `pi-runtime-auth-merge-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const agentDir = join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host");
    await mkdir(agentDir, { recursive: true });
    // Direct pi usage left an OAuth entry; a stale Pi-Science api_key remains.
    await writeFile(join(agentDir, "auth.json"), `${JSON.stringify({ anthropic: { type: "oauth", token: "t" }, openai: { type: "api_key", key: "old-openai" } })}\n`, "utf8");
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({ api_keys: { "opencode-go": "oc-go-secret" } })}\n`, "utf8");

    buildPiProcessOptions(cwd);

    const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"));
    expect(auth.anthropic).toEqual({ type: "oauth", token: "t" });
    expect(auth["opencode-go"]).toEqual({ type: "api_key", key: "oc-go-secret" });
    // Settings is the authority for api_key entries: the stale key is removed.
    expect(auth.openai).toBeUndefined();
  });

  it("removes auth.json when no API keys remain", async () => {
    const cwd = join(tmpdir(), `pi-runtime-auth-clear-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const agentDir = join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "auth.json"), `${JSON.stringify({ openai: { type: "api_key", key: "old-openai" } })}\n`, "utf8");
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({ api_keys: {} })}\n`, "utf8");

    buildPiProcessOptions(cwd);

    await expect(readFile(join(agentDir, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes custom reasoning metadata and percentage-based compaction settings", async () => {
    const cwd = join(tmpdir(), `pi-runtime-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    buildPiProcessOptions(cwd, {
      model: "custom-local/model-a",
      thinking: "high",
      compaction_enabled: true,
      compaction_threshold_percent: 80,
      model_context_window: 100000,
      skills: [],
      extensions: [],
    });
    const settings = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "settings.json"), "utf8"));
    expect(settings.compaction).toMatchObject({ enabled: true, reserveTokens: 20000, keepRecentTokens: 20000 });
  });

  it("materializes follow-up suggestion guidance as the agent append system prompt", async () => {
    const cwd = join(tmpdir(), `pi-runtime-append-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    buildPiProcessOptions(cwd);
    const guidance = await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "APPEND_SYSTEM.md"), "utf8");
    expect(guidance).toContain("<!--suggest: q1 | q2 | q3-->");
    expect(guidance).toContain("up to 3 short, concrete follow-up suggestions");
    expect(guidance).toContain("standalone message the user can copy and send directly");
    expect(guidance).toContain("written from the user's perspective as a request, question, or imperative");
    expect(guidance).toContain("Do not use assistant/agent-offering language");
    expect(guidance).toContain("我可以… / 要不要我… / I can… / Would you like me to…");
    expect(guidance).toContain("do not address the user as 你 or you when describing the agent's next step");
    expect(guidance).toContain("Use the user's language");
    expect(guidance).toContain("omit the comment when no meaningful follow-up remains");
  });

  it("materializes multi-step todo guidance in the append system prompt", async () => {
    const cwd = join(tmpdir(), `pi-runtime-todo-guidance-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    buildPiProcessOptions(cwd);
    const guidance = await readFile(join(process.env.PI_SCIENCE_HOME!, "pi-agent", "web-host", "APPEND_SYSTEM.md"), "utf8");
    expect(guidance).toContain("call the todo tool (action: create)");
    expect(guidance).toContain("exactly one task in_progress at a time");
    expect(guidance).toContain("Simple single-step requests do not need a todo list");
  });

  it("injects the Pi-Science system prompt without creating a workspace context file", async () => {
    const cwd = join(tmpdir(), `pi-runtime-system-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });

    const webOptions = buildPiProcessOptions(cwd)!;
    const webPrompts = webOptions.args.flatMap((arg, index) => arg === "--append-system-prompt" ? [webOptions.args[index + 1]] : []);
    const systemPrompt = resolve(import.meta.dirname, "../../../../..", "harness", "AGENTS.md");

    expect(webPrompts).toContain(systemPrompt);
    expect(webPrompts.some((path) => path?.endsWith("APPEND_SYSTEM.md"))).toBe(true);
    await expect(readFile(join(cwd, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    process.env.PI_SCIENCE_PI_MODE = "rpc";
    const rpcOptions = buildPiProcessOptions(cwd)!;
    const rpcPrompts = rpcOptions.args.flatMap((arg, index) => arg === "--append-system-prompt" ? [rpcOptions.args[index + 1]] : []);
    expect(rpcPrompts).toContain(systemPrompt);
    expect(rpcPrompts.some((path) => path?.endsWith("APPEND_SYSTEM.md"))).toBe(true);
  });

  it("passes workspace package isolation into the agent runtime", async () => {
    const cwd = join(tmpdir(), `pi-runtime-environment-${Date.now()}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const isolated = {
      PATH: join(cwd, ".venv", "bin"),
      PI_SCIENCE_ENVIRONMENT_PREFIX: join(cwd, ".venv"),
      npm_config_prefix: join(cwd, ".pi-science", "npm-global"),
    };

    const options = buildPiProcessOptions(cwd, undefined, undefined, isolated)!;

    expect(options.env).toMatchObject(isolated);
  });

  it("keeps outer Pi session variables out of the host and agent runtime env", async () => {
    const cwd = join(tmpdir(), `pi-runtime-env-isolation-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const previous = {
      model: process.env.PI_MODEL,
      provider: process.env.PI_PROVIDER,
      reasoning: process.env.PI_REASONING_LEVEL,
      session: process.env.PI_SESSION_ID,
      sessionFile: process.env.PI_SESSION_FILE,
    };
    process.env.PI_MODEL = "outer/model";
    process.env.PI_PROVIDER = "outer";
    process.env.PI_REASONING_LEVEL = "low";
    process.env.PI_SESSION_ID = "outer-session";
    process.env.PI_SESSION_FILE = "/tmp/outer-session.jsonl";
    try {
      const options = buildPiProcessOptions(cwd, { model: "openrouter/openai/gpt-5.1", thinking: "high", skills: [], extensions: [] })!;

      // The host env keeps the auth token but must not carry the outer Pi
      // session variables (they would shadow the workspace configuration).
      expect(options.env?.PI_ORBIT_AUTH_TOKEN).toBe(options.web?.authToken);
      expect(options.env?.PI_MODEL).toBeUndefined();
      expect(options.env?.PI_PROVIDER).toBeUndefined();
      expect(options.env?.PI_REASONING_LEVEL).toBeUndefined();
      expect(options.env?.PI_SESSION_ID).toBeUndefined();
      expect(options.env?.PI_SESSION_FILE).toBeUndefined();
      // The runtime env explicitly removes (null) the host token and the
      // per-session identity at the runtime boundary, and replaces the outer
      // model variables with the authoritative workspace configuration so the
      // agent's bash tool can identify the real model.
      const runtimeEnv = options.web?.runtime.runtimeEnv;
      expect(runtimeEnv).toBeDefined();
      expect(runtimeEnv?.PI_ORBIT_AUTH_TOKEN).toBeNull();
      expect(runtimeEnv?.PI_SESSION_ID).toBeNull();
      expect(runtimeEnv?.PI_SESSION_FILE).toBeNull();
      expect(runtimeEnv?.PI_PROVIDER).toBe("openrouter");
      expect(runtimeEnv?.PI_MODEL).toBe("openai/gpt-5.1");
      expect(runtimeEnv?.PI_REASONING_LEVEL).toBe("high");
      expect(options.web?.runtime.model).toBe("openrouter/openai/gpt-5.1");
      expect(options.web?.runtime.thinking).toBe("high");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        const name = { model: "PI_MODEL", provider: "PI_PROVIDER", reasoning: "PI_REASONING_LEVEL", session: "PI_SESSION_ID", sessionFile: "PI_SESSION_FILE" }[key as keyof typeof previous]!;
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("passes generated runtime credentials into the Pi Orbit runtime env", async () => {
    const credentials = new CredentialStore();
    await credentials.put({ id: "cred-lab", kind: "api_key", backend: "managed", secret: "runtime-env-secret" });
    const state = emptyModelResourceState();
    state.migration = { version: 1, completed_at: new Date().toISOString() };
    state.providers.push({ id: "user-lab", name: "Lab", kind: "user", adapter: "openai-compatible", enabled: true, catalog_mode: "hybrid", auth_kind: "api_key", source: "user" });
    state.endpoints.push({ id: "ep-lab", name: "Lab", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", credential_ref: "cred-lab", enabled: true, health: "unknown", data_egress: "local" });
    state.bindings.push({ id: "bind-lab", provider_id: "user-lab", endpoint_id: "ep-lab", enabled: true, priority: 1 });
    state.models.push({ provider_id: "user-lab", model_id: "model-a", display_name: "Lab · model-a", enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: null, max_output_tokens: null }, capability_source: "manual" });
    await new ModelResourceRepository().replace(state);

    const cwd = join(tmpdir(), `pi-runtime-credential-env-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const options = buildPiProcessOptions(cwd, { model: "user-lab/model-a", thinking: "low", skills: [], extensions: [] })!;
    const variable = runtimeCredentialEnvName("cred-lab");
    // The host env and the runtime creation request both carry the value:
    // Pi Orbit creates the runtime child with the runtimeEnv exactly, so
    // models.json $PI_RUNTIME_CREDENTIAL_* references must resolve there.
    expect(options.env?.[variable]).toBe("runtime-env-secret");
    expect(options.web?.runtime.runtimeEnv?.[variable]).toBe("runtime-env-secret");
    expect(options.web?.runtime.model).toBe("user-lab/model-a");
  });

  it("launches with the projected runtime identity (split endpoint + model alias)", async () => {
    const credentials = new CredentialStore();
    await credentials.put({ id: "cred-a", kind: "api_key", backend: "managed", secret: "secret-a" });
    await credentials.put({ id: "cred-b", kind: "api_key", backend: "managed", secret: "secret-b" });
    const state = emptyModelResourceState();
    state.migration = { version: 1, completed_at: new Date().toISOString() };
    state.providers.push({ id: "user-lab", name: "Lab", kind: "user", adapter: "openai-compatible", enabled: true, catalog_mode: "hybrid", auth_kind: "api_key", source: "user" });
    state.endpoints.push(
      { id: "ep-a", name: "A", base_url: "http://127.0.0.1:8001/v1", protocol: "openai", credential_ref: "cred-a", enabled: true, health: "unknown", data_egress: "local" },
      { id: "ep-b", name: "B", base_url: "http://127.0.0.1:8002/v1", protocol: "openai", credential_ref: "cred-b", enabled: true, health: "unknown", data_egress: "remote" },
    );
    state.bindings.push(
      { id: "bind-a", provider_id: "user-lab", endpoint_id: "ep-a", enabled: true, priority: 1, model_allowlist: ["model-a"], model_aliases: { "model-a": "remote-model-a" } },
      { id: "bind-b", provider_id: "user-lab", endpoint_id: "ep-b", enabled: true, priority: 2, model_allowlist: ["model-b"] },
    );
    state.models.push(
      { provider_id: "user-lab", model_id: "model-a", display_name: "Lab · model-a", enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: null, max_output_tokens: null }, capability_source: "manual" },
      { provider_id: "user-lab", model_id: "model-b", display_name: "Lab · model-b", enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: null, max_output_tokens: null }, capability_source: "manual" },
    );
    await new ModelResourceRepository().replace(state);

    const cwd = join(tmpdir(), `pi-runtime-identity-split-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const options = buildPiProcessOptions(cwd, { model: "user-lab/model-a", thinking: "low", skills: [], extensions: [] })!;
    expect(options.web?.runtime.model).toBe("user-lab--ep-a/remote-model-a");
    expect(options.args).toContain("--model");
    expect(options.args[options.args.indexOf("--model") + 1]).toBe("user-lab--ep-a/remote-model-a");
    expect(options.web?.runtime.runtimeEnv?.PI_PROVIDER).toBe("user-lab--ep-a");
    expect(options.web?.runtime.runtimeEnv?.PI_MODEL).toBe("remote-model-a");
  });

  it("launches with the projected runtime identity for a single endpoint + model alias", async () => {
    const credentials = new CredentialStore();
    await credentials.put({ id: "cred-a", kind: "api_key", backend: "managed", secret: "secret-a" });
    const state = emptyModelResourceState();
    state.migration = { version: 1, completed_at: new Date().toISOString() };
    state.providers.push({ id: "user-lab", name: "Lab", kind: "user", adapter: "openai-compatible", enabled: true, catalog_mode: "hybrid", auth_kind: "api_key", source: "user" });
    state.endpoints.push({ id: "ep-a", name: "A", base_url: "http://127.0.0.1:8001/v1", protocol: "openai", credential_ref: "cred-a", enabled: true, health: "unknown", data_egress: "local" });
    state.bindings.push({ id: "bind-a", provider_id: "user-lab", endpoint_id: "ep-a", enabled: true, priority: 1, model_aliases: { "model-a": "remote-model-a" } });
    state.models.push({ provider_id: "user-lab", model_id: "model-a", display_name: "Lab · model-a", enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: null, max_output_tokens: null }, capability_source: "manual" });
    await new ModelResourceRepository().replace(state);

    const cwd = join(tmpdir(), `pi-runtime-identity-single-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const options = buildPiProcessOptions(cwd, { model: "user-lab/model-a", thinking: "low", skills: [], extensions: [] })!;
    expect(options.web?.runtime.model).toBe("user-lab/remote-model-a");
    expect(options.web?.runtime.runtimeEnv?.PI_PROVIDER).toBe("user-lab");
    expect(options.web?.runtime.runtimeEnv?.PI_MODEL).toBe("remote-model-a");
  });

  it("strips outer Pi session variables injected through the workspace environment too", async () => {
    const cwd = join(tmpdir(), `pi-runtime-env-isolation-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    process.env.PI_MODEL = "outer/model";
    try {
      const options = buildPiProcessOptions(cwd, undefined, undefined, {
        PATH: join(cwd, ".venv", "bin"),
        PI_MODEL: "workspace/model",
        PI_SESSION_ID: "workspace-session",
      })!;

      expect(options.env?.PI_MODEL).toBeUndefined();
      expect(options.env?.PI_SESSION_ID).toBeUndefined();
      // Legitimate workspace environment values still reach the runtime.
      expect(options.env?.PATH).toBe(join(cwd, ".venv", "bin"));
      const runtimeEnv = options.web?.runtime.runtimeEnv;
      // Without a workspace model there is nothing to expose: the outer and
      // workspace-injected PI_MODEL are stripped, and the per-session
      // identity stays removed at the boundary.
      expect(runtimeEnv?.PI_MODEL).toBeNull();
      expect(runtimeEnv?.PI_PROVIDER).toBeNull();
      expect(runtimeEnv?.PI_REASONING_LEVEL).toBeNull();
      expect(runtimeEnv?.PI_SESSION_ID).toBeNull();
      expect(runtimeEnv?.PATH).toBe(join(cwd, ".venv", "bin"));
    } finally {
      delete process.env.PI_MODEL;
    }
  });

  it("exposes the effective workspace model/provider/thinking to the agent bash env", async () => {
    const cwd = join(tmpdir(), `pi-runtime-session-env-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const previous = process.env.PI_MODEL;
    process.env.PI_MODEL = "outer/model";
    try {
      const options = buildPiProcessOptions(cwd, { model: "custom-custom-api/minimax-m2.5", thinking: "high", skills: [], extensions: [] })!;

      const runtimeEnv = options.web?.runtime.runtimeEnv;
      expect(runtimeEnv).toBeDefined();
      // The agent's bash tool sees the real session model identity, not the
      // outer shell value and not null.
      expect(runtimeEnv?.PI_PROVIDER).toBe("custom-custom-api");
      expect(runtimeEnv?.PI_MODEL).toBe("minimax-m2.5");
      expect(runtimeEnv?.PI_REASONING_LEVEL).toBe("high");
      expect(runtimeEnv?.PI_MODEL).not.toBe("outer/model");
      // The runtime descriptor carries the same identity for the control plane.
      expect(options.web?.runtime.model).toBe("custom-custom-api/minimax-m2.5");
      expect(options.web?.runtime.thinking).toBe("high");
    } finally {
      if (previous === undefined) delete process.env.PI_MODEL;
      else process.env.PI_MODEL = previous;
    }
  });

  it("falls back to the workspace settings model when no config is passed", async () => {
    const cwd = join(tmpdir(), `pi-runtime-session-env-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), `${JSON.stringify({ model: "deepseek/deepseek-chat", thinking: "off" })}\n`, "utf8");

    const options = buildPiProcessOptions(cwd)!;

    const runtimeEnv = options.web?.runtime.runtimeEnv;
    expect(runtimeEnv?.PI_PROVIDER).toBe("deepseek");
    expect(runtimeEnv?.PI_MODEL).toBe("deepseek-chat");
    expect(runtimeEnv?.PI_REASONING_LEVEL).toBe("off");
  });

  it("passes a manifest-discovered runtime extension exactly once", async () => {
    const runtimeRoot = join(tmpdir(), `pi-runtime-manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cwd = join(tmpdir(), `pi-runtime-extension-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(runtimeRoot, cwd);
    const cli = join(runtimeRoot, "packages", "coding-agent", "dist", "cli.js");
    const extension = join(runtimeRoot, "node_modules", "pi-subagents", "src", "extension.ts");
    await mkdir(join(runtimeRoot, "packages", "coding-agent", "dist"), { recursive: true });
    await mkdir(join(runtimeRoot, "node_modules", "pi-subagents", "src"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(cli, "", "utf8");
    await writeFile(extension, "export default function extension() {}\n", "utf8");
    await writeFile(join(runtimeRoot, "node_modules", "pi-subagents", "package.json"), JSON.stringify({ pi: { extensions: ["src/extension.ts"] } }), "utf8");
    process.env.PI_CLI_PATH = cli;

    // Inject the test runtime root explicitly: without it, a vendored
    // managed runtime checkout (runtime/pi) shadows this tmpdir scenario.
    const options = buildPiProcessOptions(cwd, loadDefaultPiConfig([runtimeRoot]))!;
    const extensions = options.args.flatMap((arg, index) => arg === "-e" ? [options.args[index + 1]] : []);

    expect(extensions.filter((path) => path === extension)).toHaveLength(1);
    expect(extensions).not.toContain("pi-subagents/index.ts");
  });

  it("discovers the registered rpiv-todo extension from an injected package root", async () => {
    const runtimeRoot = join(tmpdir(), `pi-runtime-todo-manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cli = join(runtimeRoot, "packages", "coding-agent", "dist", "cli.js");
    const packageDir = join(runtimeRoot, "node_modules", "@juicesharp", "rpiv-todo");
    const extension = join(packageDir, "index.ts");
    cleanup.push(runtimeRoot);
    await mkdir(join(runtimeRoot, "packages", "coding-agent", "dist"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(cli, "", "utf8");
    await writeFile(extension, "export default function extension() {}\n", "utf8");
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }), "utf8");

    const todo = runtimeExtensionStatus(cli, [runtimeRoot]).find((item) => item.id === "rpiv-todo");
    const config = loadDefaultPiConfig([runtimeRoot]);

    expect(todo).toMatchObject({ id: "rpiv-todo", name: "Todo", installed: true, path: extension });
    expect(config.extensions).toContain(extension);
  });

  it("auto-discovers rpiv-todo from Pi's managed npm root", async () => {
    const installHome = join(tmpdir(), `pi-runtime-todo-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const packageDir = join(installHome, ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-todo");
    const extension = join(packageDir, "index.ts");
    cleanup.push(installHome);
    await mkdir(packageDir, { recursive: true });
    await writeFile(extension, "export default function extension() {}\n", "utf8");
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ pi: { extensions: ["index.ts"] } }), "utf8");
    process.env.HOME = installHome;
    // os.homedir() reads USERPROFILE on Windows (HOME is not consulted), so the
    // managed-npm-root discovery test must override both or it cannot find the
    // injected package on windows runners.
    process.env.USERPROFILE = installHome;

    const todo = runtimeExtensionStatus(process.env.PI_CLI_PATH!, [join(installHome, ".pi", "agent", "npm")]).find((item) => item.id === "rpiv-todo");

    expect(todo).toMatchObject({ installed: true, path: extension });
  });

  it("uses the Pi-Science questionnaire bridge instead of registering the upstream duplicate tool", async () => {
    const cwd = join(tmpdir(), `pi-runtime-questionnaire-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const upstream = join(cwd, "node_modules", "@juicesharp", "rpiv-ask-user-question", "index.ts");
    const options = buildPiProcessOptions(cwd, { skills: [], extensions: [upstream] })!;
    const extensions = options.args.flatMap((arg, index) => arg === "-e" ? [options.args[index + 1]] : []);
    const adapter = join(import.meta.dirname, "extensions", "pi-science-ask-user-question-web.ts");

    expect(extensions[0]).toBe(adapter);
    expect(extensions).not.toContain(upstream);
  });

  it("runs a source TypeScript CLI through the adjacent tsx runtime", async () => {
    const piRoot = join(tmpdir(), `pi-source-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(piRoot);
    const cli = join(piRoot, "packages", "coding-agent", "src", "cli.ts");
    const tsx = join(piRoot, "node_modules", ".bin", "tsx");
    await mkdir(join(piRoot, "packages", "coding-agent", "src"), { recursive: true });
    await mkdir(join(piRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(cli, "export {};\n", "utf8");
    await writeFile(tsx, "", "utf8");
    process.env.PI_CLI_PATH = cli;
    delete process.env.PI_TSX_PATH;
    delete process.env.PI_TSCONFIG_PATH;

    const options = buildPiProcessOptions(piRoot)!;
    expect(options.args.slice(0, 2)).toEqual([tsx, cli]);
  });

  it("runs a native Pi Orbit release executable directly", async () => {
    const cwd = join(tmpdir(), `pi-runtime-native-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    const cli = join(cwd, "pi-orbit");
    await writeFile(cli, "", "utf8");
    process.env.PI_CLI_PATH = cli;

    const options = buildPiProcessOptions(cwd)!;

    expect(options.command).toBe(cli);
    expect(options.args[0]).toBe("--mode");
    expect(options.args).not.toContain(cli);
  });

  it("launches Pi in authenticated app-managed web mode", async () => {
    const cwd = join(tmpdir(), `pi-runtime-web-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });

    const options = buildPiProcessOptions(cwd)!;

    expect(options.args).toContain("web");
    expect(options.args).not.toContain("rpc");
    expect(options.args).toContain("--web-app-managed");
    expect(options.args).toContain("--no-session");
    expect(options.args).toContain("--approve");
    expect(options.args).not.toContain("--session-dir");
    expect(options.args).not.toContain("--auth-token");
    expect(options.web?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(options.web?.authToken).toBeTruthy();
    expect(options.env?.PI_ORBIT_AUTH_TOKEN).toBe(options.web?.authToken);
    expect(options.web?.runtime).toMatchObject({ cwd, sessionDir: join(cwd, ".pi-science", "sessions") });
  });

  it("allows isolated runtimes to override the web session directory", async () => {
    const cwd = join(tmpdir(), `pi-runtime-isolated-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const isolatedSessions = join(cwd, ".pi-science", "title-runtimes", "runtime-1");
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });

    const options = buildPiProcessOptions(cwd, undefined, undefined, {}, isolatedSessions)!;

    expect(options.web?.runtime.sessionDir).toBe(isolatedSessions);
    expect(options.web?.runtime.sessionDir).not.toBe(join(cwd, ".pi-science", "sessions"));
  });

  it("restores the global skill policy when creating a Pi Orbit runtime", async () => {
    const cwd = join(tmpdir(), `pi-runtime-skills-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), JSON.stringify({
      skill_policy: { mode: "denylist", skills: ["browser"] },
    }), "utf8");

    const options = buildPiProcessOptions(cwd)!;

    expect(options.web?.runtime.skillPolicy).toEqual({ mode: "denylist", skills: ["browser"] });
  });

  it("reuses the shared web port and token until reset allocates fresh ones", () => {
    const cwd = join(tmpdir(), `pi-runtime-shared-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    mkdirSync(cwd, { recursive: true });
    const first = buildPiProcessOptions(cwd)!;
    const second = buildPiProcessOptions(cwd)!;
    expect(second.web?.baseUrl).toBe(first.web?.baseUrl);
    expect(second.web?.authToken).toBe(first.web?.authToken);

    // A host start failure (e.g. EADDRINUSE) resets the singleton so the next
    // attempt self-heals with a different port/token.
    resetWebRuntimeAllocation();
    const after = buildPiProcessOptions(cwd)!;
    expect(after.web?.baseUrl).not.toBe(first.web?.baseUrl);
    expect(after.web?.authToken).not.toBe(first.web?.authToken);
  });

  it("reuses one port and auth token across calls instead of leaking new ones", async () => {
    const cwd = join(tmpdir(), `pi-runtime-shared-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(cwd);
    await mkdir(cwd, { recursive: true });

    const first = buildPiProcessOptions(cwd)!;
    const second = buildPiProcessOptions(cwd)!;
    const third = buildPiProcessOptions(cwd)!;

    expect(second.web?.baseUrl).toBe(first.web?.baseUrl);
    expect(third.web?.baseUrl).toBe(first.web?.baseUrl);
    expect(second.web?.authToken).toBe(first.web?.authToken);
    expect(third.env?.PI_ORBIT_AUTH_TOKEN).toBe(first.env?.PI_ORBIT_AUTH_TOKEN);
  });

  it("surfaces models.json deletion failures except for a missing file", async () => {
    const cwd = await obstructModelsFile();
    expect(() => buildPiProcessOptions(cwd)).toThrow(/EISDIR|operation not permitted|permission denied/i);
  });

  it("surfaces models.json write failures", async () => {
    const cwd = await obstructModelsFile([{ id: "local", name: "Local", base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", models: ["local-model"] }]);
    expect(() => buildPiProcessOptions(cwd)).toThrow(/EISDIR|operation not permitted|permission denied/i);
  });
});
