import { describe, expect, it } from "vitest";
import { providerViewsFixture } from "../../../../tests/fixtures/provider-views";
import { buildServices } from "./model-utils";

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
