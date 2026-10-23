import { describe, expect, it } from "vitest";
import { modelCapabilitySources } from "@pi-science/contracts";
import { providerViewsFixture } from "../../../../tests/fixtures/provider-views";
import { applyModelEdits, buildServices, mergeDiscoveredModels, modelConfigFromDiscovery } from "./model-utils";

const fixture = providerViewsFixture({ providers: [{ id: "user-lab", name: "Lab", custom: true, has_key: false, models: ["model-a"], credential_status: "needs_key" }], available_models: [], custom_providers: [] }).providers[0];
describe("ProviderView presentation", () => {
  it.each(["ready", "needs_key", "invalid", "needs_login", "unavailable", "disabled"] as const)("preserves the server's %s status and configured models", (status) => {
    const service = buildServices([{ ...fixture, status }])[0];
    expect(service.status).toBe(status);
    expect(service.models).toHaveLength(1);
    expect(service.models[0]).toMatchObject({ available: false, contextWindow: null, maxOutputTokens: null, reason: "missing_credential" });
  });
  it("does not override Core availability using credential state", () => {
    const service = buildServices([{ ...fixture, status: "ready", models: [{ ...fixture.models[0], available: true }] }])[0];
    expect(service.models[0].available).toBe(true);
    expect(service.view.credential.configured).toBe(false);
  });
  it("does not fabricate input formats from vision capability", () => {
    const service = buildServices([{ ...fixture, models: [{ ...fixture.models[0], input_formats: undefined, capabilities: { ...fixture.models[0].capabilities, vision: true } }] }])[0];
    expect(service.models[0].inputFormats).toEqual([]);
  });

});

describe("discovered capabilities and persistent corrections", () => {
  it("does not store runtime defaults as upstream facts", () => {
    expect(modelConfigFromDiscovery({ id: "m" })).toEqual({});
    expect(modelConfigFromDiscovery(undefined)).toEqual({});
    expect(modelConfigFromDiscovery({ id: "reasoner", capabilities: { reasoning: true } })).not.toHaveProperty("thinkingLevelMap");
    expect(modelConfigFromDiscovery({ id: "reasoner", capabilities: { reasoning: true, thinking_levels: ["off", "high"] } }).thinkingLevelMap).toMatchObject({ off: "off", high: "high", max: null });
    expect(modelConfigFromDiscovery({ id: "m", capabilities: { context_window: 8192 } })).toEqual({ contextWindow: 8192, discoveredFields: ["contextWindow"] });
  });
  it("keeps manual corrections in a separate layer across save, refresh and reopen", () => {
    const discovered = [{ id: "m", capabilities: { context_window: 8192, reasoning: true, vision: true } }];
    const initial = mergeDiscoveredModels([], discovered, {}, { m: { contextWindow: 128000, reasoning: false, input: ["text"] } });
    expect(initial.models[0]).toMatchObject({ contextWindow: 8192, reasoning: true });
    expect(initial.modelOverrides.m).toMatchObject({ contextWindow: 128000, reasoning: false, input: ["text"] });
    const reopened = JSON.parse(JSON.stringify(initial));
    const refreshed = mergeDiscoveredModels(reopened.models, [{ id: "m", capabilities: { context_window: 16000, reasoning: true } }], reopened.modelOverrides);
    expect(refreshed.modelOverrides.m?.contextWindow).toBe(128000);
    expect(modelCapabilitySources({ models: refreshed.models, modelOverrides: refreshed.modelOverrides }, "m")).toMatchObject({ contextWindow: "user_override", reasoning: "user_override", maxTokens: "default" });
    const reset = mergeDiscoveredModels(refreshed.models, discovered, refreshed.modelOverrides, { m: { contextWindow: null, reasoning: null, input: null } });
    expect(reset.modelOverrides.m).toBeUndefined();
    expect(modelCapabilitySources({ models: reset.models }, "m").contextWindow).toBe("declared");
  });
  it("does not count equal values, object key order, or duplicate discovery IDs as changes", () => {
    const first = mergeDiscoveredModels([], [{ id: "m", capabilities: { context_window: 8192, reasoning: true } }]);
    const again = mergeDiscoveredModels(first.models, [{ id: "m", capabilities: { reasoning: true, context_window: 8192 } }, { id: "m", capabilities: { context_window: 8192, reasoning: true } }]);
    expect(again).toMatchObject({ added: 0, updated: 0, conflicts: [] });
  });
  it("requests an explicit decision for old untracked values and can preserve or replace them", () => {
    const old = [{ id: "m", contextWindow: 128000 }], found = [{ id: "m", capabilities: { context_window: 8192 } }];
    expect(mergeDiscoveredModels(old, found).conflicts).toEqual([{ id: "m", field: "contextWindow", current: 128000, discovered: 8192 }]);
    const kept = mergeDiscoveredModels(old, found, {}, {}, "preserve");
    expect(kept.modelOverrides.m?.contextWindow).toBe(128000); expect(kept.models[0]?.contextWindow).toBe(8192);
    const replaced = mergeDiscoveredModels(old, found, {}, {}, "replace");
    expect(replaced.models[0]?.contextWindow).toBe(8192); expect(replaced.modelOverrides).toEqual({});
  });
  it("applies explicit false and drops previously discovered capabilities when no longer declared", () => {
    const initial = mergeDiscoveredModels([], [{ id: "m", capabilities: { reasoning: true, vision: true, max_output_tokens: 4096 } }]);
    const next = mergeDiscoveredModels(initial.models, [{ id: "m", capabilities: { reasoning: false, vision: false } }]);
    expect(next.models[0]).toMatchObject({ reasoning: false, input: ["text"] });
    expect(next.models[0]).not.toHaveProperty("thinkingLevelMap"); expect(next.models[0]).not.toHaveProperty("maxTokens");
    expect(applyModelEdits({ reasoning: true, thinkingLevelMap: { max: "high" } }, { reasoning: false })).toEqual({ reasoning: false });
  });
  it("preserves unrelated override headers, costs, manual models and unreported capabilities", () => {
    const initial = [{ id: "manual", contextWindow: 8192 }];
    expect(mergeDiscoveredModels(initial, []).models).toEqual(initial);
    expect(applyModelEdits({ name: "Custom", headers: { accept: "application/json" }, contextWindow: 65536 }, { contextWindow: null })).toEqual({ name: "Custom", headers: { accept: "application/json" } });
  });
});
