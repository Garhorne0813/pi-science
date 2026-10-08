import { describe, expect, it } from "vitest";
import type { SettingsConfig } from "../../../lib/settings";
import { buildServices } from "./model-utils";

function config(providers: SettingsConfig["providers"], customProviders: SettingsConfig["custom_providers"] = []): SettingsConfig {
  return {
    api_keys: {}, model: "", thinking: "high", providers, custom_providers: customProviders,
    available_models: [
      { id: "user-lab/model-a", provider: "user-lab", model: "model-a", label: "Lab · Model A", custom: true, reasoning: false, thinking_levels: [], capability_source: "manual", context_window: 128000, max_output_tokens: 8192 },
    ],
    compaction_enabled: true, compaction_threshold_percent: 85,
  };
}

describe("buildServices", () => {
  it("deduplicates runtime and canonical views of one custom provider", () => {
    const services = buildServices(config([
      { id: "custom-lab", name: "Lab runtime", models: ["custom-lab/model-a"], has_key: true, enabled: true, credential_status: "configured", custom: true },
      { id: "user-lab", name: "Lab", models: ["user-lab/model-a"], has_key: true, enabled: true, credential_status: "configured", custom: true },
    ], [{ id: "lab", name: "Legacy Lab", base_url: "http://localhost:8000/v1", api: "openai-completions", models: ["model-a"], has_key: true }]));

    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ id: "user-lab", name: "Lab", custom: true });
    expect(services[0].models.map((model) => model.id)).toEqual(["user-lab/model-a"]);
  });
  it("retains a keyless builtin even when the legacy enabled flag is false", () => {
    const services = buildServices(config([{ id: "local", name: "Local", models: [], has_key: false, enabled: false, credential_status: "connected", auth: { kind: "none", api_key_supported: false, oauth_supported: false, login_supported: false } }]));
    expect(services).toEqual([expect.objectContaining({ id: "local", status: "unreachable", auth: { kind: "none", api_key_supported: false, oauth_supported: false, login_supported: false } })]);
  });

  it("does not label invalid or OAuth-only credentials as connected", () => {
    expect(buildServices(config([
      { id: "bad", name: "Bad", models: [], has_key: true, credential_status: "invalid", enabled: true },
      { id: "subscription", name: "Subscription", models: [], has_key: true, credential_status: "connected", auth: { kind: "oauth", api_key_supported: false, oauth_supported: true, login_supported: false } },
    ]))).toEqual([]);
  });

  it.each([
    ["needs_key", true, "needs_key"],
    ["invalid", true, "needs_key"],
    ["needs_login", true, "needs_login"],
    ["configured", false, "disabled"],
  ] as const)("keeps a %s custom provider in the inventory", (credentialStatus, enabled, status) => {
    const services = buildServices({ ...config([{ id: "user-lab", name: "Lab", models: ["model-a"], has_key: credentialStatus === "configured", credential_status: credentialStatus, enabled, custom: true }]), available_models: [] });
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ id: "user-lab", name: "Lab", status, custom: true });
    expect(services[0].models).toEqual([expect.objectContaining({ id: "user-lab/model-a", available: false, contextWindow: null, maxOutputTokens: null, inputFormats: [] })]);
  });

  it("keeps a legacy custom provider with no key manageable using its canonical ID", () => {
    const services = buildServices(config([], [{ id: "lab", name: "Legacy Lab", base_url: "https://lab.example/v1", api: "openai-completions", models: ["model-a"], has_key: false }]));
    expect(services[0]).toMatchObject({ id: "user-lab", name: "Legacy Lab", status: "needs_key", custom: true });
  });

});
