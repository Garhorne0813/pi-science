import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "../../model-resources/credential-store.js";
import { ModelResourceRepository, emptyModelResourceState } from "../../model-resources/model-resource-repository.js";
import { projectPiRuntime } from "./pi-runtime-projection.js";
import { runtimeCredentialEnvName } from "../../model-resources/runtime-credential-env.js";

const roots: string[] = [];
const originalHome = process.env.PI_SCIENCE_HOME;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-science-runtime-projection-"));
  roots.push(root);
  process.env.PI_SCIENCE_HOME = root;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("Pi runtime projection", () => {
  it("projects canonical routes and injects an opaque credential without putting it in runtime descriptors", async () => {
    const repository = new ModelResourceRepository();
    const credentials = new CredentialStore();
    await credentials.put({ id: "cred-lab", kind: "api_key", backend: "managed", secret: "projection-secret" });
    const state = emptyModelResourceState();
    state.migration = { version: 1, completed_at: new Date().toISOString() };
    state.providers.push({ id: "user-lab", name: "Lab", kind: "user", adapter: "openai-compatible", enabled: true, catalog_mode: "hybrid", auth_kind: "api_key", source: "user" });
    state.endpoints.push({ id: "ep-lab", name: "Lab", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", credential_ref: "cred-lab", enabled: true, health: "unknown", data_egress: "local" });
    state.bindings.push({ id: "bind-lab", provider_id: "user-lab", endpoint_id: "ep-lab", enabled: true, priority: 1 });
    state.models.push({ provider_id: "user-lab", model_id: "model-a", display_name: "Lab · model-a", enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: 32_768, max_output_tokens: null }, capability_source: "manual" });
    await repository.replace(state);
    // The projection reads the persisted state, so the repository write above
    // is the canonical input for this assertion.
    const agentDir = join(process.env.PI_SCIENCE_HOME!, "agent");
    await mkdir(agentDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    const result = projectPiRuntime(agentDir, process.env.PI_SCIENCE_HOME!, env);
    const catalog = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as { providers: Record<string, Record<string, unknown>> };
    const variable = runtimeCredentialEnvName("cred-lab");
    expect(result.providers["user-lab"]).toMatchObject({ api: "openai-completions", apiKey: `$${variable}` });
    expect(env[variable]).toBe("projection-secret");
    expect(JSON.stringify(catalog)).not.toContain("projection-secret");
    await writeFile(join(agentDir, "runtime-env.json"), JSON.stringify({ [variable]: env[variable] }), "utf8");
    expect(JSON.parse(await readFile(join(agentDir, "runtime-env.json"), "utf8"))[variable]).toBe("projection-secret");
  });

  it("projects disjoint endpoint routes and model aliases onto separate runtime providers", async () => {
    const repository = new ModelResourceRepository();
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
    await repository.replace(state);
    const agentDir = join(process.env.PI_SCIENCE_HOME!, "agent");
    await mkdir(agentDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    const result = projectPiRuntime(agentDir, process.env.PI_SCIENCE_HOME!, env);
    const catalog = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as { providers: Record<string, { baseUrl: string; apiKey?: string; models: Array<{ id: string }> }> };
    const variableA = runtimeCredentialEnvName("cred-a");
    const variableB = runtimeCredentialEnvName("cred-b");
    expect(result.providers["user-lab--ep-a"]).toMatchObject({ baseUrl: "http://127.0.0.1:8001/v1", apiKey: `$${variableA}` });
    expect(result.providers["user-lab--ep-b"]).toMatchObject({ baseUrl: "http://127.0.0.1:8002/v1", apiKey: `$${variableB}` });
    expect(catalog.providers["user-lab--ep-a"]?.models.map((model) => model.id)).toEqual(["remote-model-a"]);
    expect(catalog.providers["user-lab--ep-b"]?.models.map((model) => model.id)).toEqual(["model-b"]);
    expect(result.providers["user-lab"]).toBeUndefined();
    expect(env[variableA]).toBe("secret-a");
    expect(env[variableB]).toBe("secret-b");
    expect(JSON.stringify(catalog)).not.toContain("secret-a");
    expect(JSON.stringify(catalog)).not.toContain("secret-b");
    expect(result.modelRefs["user-lab/model-a"]).toBe("user-lab--ep-a/remote-model-a");
    expect(result.modelRefs["user-lab/model-b"]).toBe("user-lab--ep-b/model-b");
  });

  it("maps a single endpoint + model alias to a stable runtime ref", async () => {
    const repository = new ModelResourceRepository();
    const credentials = new CredentialStore();
    await credentials.put({ id: "cred-a", kind: "api_key", backend: "managed", secret: "secret-a" });
    const state = emptyModelResourceState();
    state.migration = { version: 1, completed_at: new Date().toISOString() };
    state.providers.push({ id: "user-lab", name: "Lab", kind: "user", adapter: "openai-compatible", enabled: true, catalog_mode: "hybrid", auth_kind: "api_key", source: "user" });
    state.endpoints.push({ id: "ep-a", name: "A", base_url: "http://127.0.0.1:8001/v1", protocol: "openai", credential_ref: "cred-a", enabled: true, health: "unknown", data_egress: "local" });
    state.bindings.push({ id: "bind-a", provider_id: "user-lab", endpoint_id: "ep-a", enabled: true, priority: 1, model_aliases: { "model-a": "remote-model-a" } });
    state.models.push({ provider_id: "user-lab", model_id: "model-a", display_name: "Lab · model-a", enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: null, max_output_tokens: null }, capability_source: "manual" });
    await repository.replace(state);
    const agentDir = join(process.env.PI_SCIENCE_HOME!, "agent");
    await mkdir(agentDir, { recursive: true });
    const result = projectPiRuntime(agentDir, process.env.PI_SCIENCE_HOME!, {});
    expect(result.providers["user-lab"]).toBeDefined();
    expect(result.providers["user-lab--ep-a"]).toBeUndefined();
    expect(result.modelRefs["user-lab/model-a"]).toBe("user-lab/remote-model-a");
  });
});
