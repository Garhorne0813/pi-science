import { describe, expect, it } from "vitest";
import { hasEnvApiKey, loadPiAiProviderCatalog } from "./pi-ai-provider-catalog.js";

describe("pi-ai provider catalog adapter", () => {
  it("loads the real runtime catalog including OpenCode Go with API-key auth and models", async () => {
    const catalog = await loadPiAiProviderCatalog();
    const opencodeGo = catalog.find((provider) => provider.id === "opencode-go");
    expect(opencodeGo).toBeDefined();
    expect(opencodeGo?.name).toBe("OpenCode Go");
    expect(opencodeGo?.apiKeySupported).toBe(true);
    expect(opencodeGo?.oauthSupported).toBe(false);
    expect(opencodeGo?.modelIds.length).toBeGreaterThan(0);

    const opencode = catalog.find((provider) => provider.id === "opencode");
    expect(opencode).toBeDefined();
    expect(opencode?.name).toBe("OpenCode Zen");
    expect(opencode?.apiKeySupported).toBe(true);
    expect(opencode?.modelIds.length).toBeGreaterThan(0);
  });

  it("marks OpenAI Codex as OAuth-only subscription and never leaks key values", async () => {
    const catalog = await loadPiAiProviderCatalog();
    const codex = catalog.find((provider) => provider.id === "openai-codex");
    expect(codex).toBeDefined();
    expect(codex?.apiKeySupported).toBe(false);
    expect(codex?.oauthSupported).toBe(true);
    expect(codex?.subscription).toBe(true);
    // Every entry's credential surface is booleans only — no key material.
    expect(JSON.stringify(catalog)).not.toMatch(/sk-[A-Za-z0-9]|Bearer|api_key"\s*:\s*"/);
  });

  it("reports environment credentials as booleans only", async () => {
    const previous = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      await expect(hasEnvApiKey("opencode-go")).resolves.toBe(false);
      process.env.OPENCODE_API_KEY = "test-key-value";
      await expect(hasEnvApiKey("opencode-go")).resolves.toBe(true);
      // Boolean only: the raw value must never be returned by the adapter.
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previous;
    }
  });
});
