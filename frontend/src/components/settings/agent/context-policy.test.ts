import { describe, expect, it } from "vitest";
import type { SettingsConfig } from "../../../lib/settings";
import { contextPolicy } from "./context-policy";

const config: SettingsConfig = { api_keys: {}, model: "lab/one", thinking: "high", providers: [], custom_providers: [], compaction_enabled: true, compaction_threshold_percent: 85, model_context_window: 1000000, available_models: [{ id: "lab/one", provider: "lab", model: "one", label: "Lab · One", custom: true, reasoning: true, thinking_levels: ["high"], context_window: 128000, capability_source: "runtime" }] };

describe("Settings context preview", () => {
  it("uses model facts instead of the old cached model window", () => {
    expect(contextPolicy(config)).toMatchObject({ window: 128000, compactionPointTokens: 108800, compaction: { reserveTokens: 19200 } });
  });
  it("applies only the explicit override for this model", () => {
    expect(contextPolicy({ ...config, model_context_window_override: { model: "lab/one", context_window: 4096 } })).toMatchObject({ window: 4096, compactionPointTokens: 3481 });
    expect(contextPolicy({ ...config, model_context_window_override: { model: "lab/two", context_window: 4096 } })?.window).toBe(128000);
  });
  it("does not invent capacity for a missing, unavailable or unknown model", () => {
    expect(contextPolicy({ ...config, available_models: [] })).toBeNull();
    expect(contextPolicy({ ...config, unavailable_model: "lab/one" })).toBeNull();
    expect(contextPolicy({ ...config, available_models: [{ ...config.available_models[0], context_window: null }] })).toBeNull();
  });
});
