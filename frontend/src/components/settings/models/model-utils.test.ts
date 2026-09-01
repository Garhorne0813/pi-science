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
});
