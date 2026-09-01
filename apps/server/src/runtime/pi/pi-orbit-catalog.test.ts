import { describe, expect, it, vi } from "vitest";
import type { PiManager } from "./pi-manager.js";
import { PiOrbitCatalogService } from "./pi-orbit-catalog.js";

const options = { cwd: "/tmp/catalog", command: "pi-orbit", args: [], web: { baseUrl: "http://127.0.0.1:1234", authToken: "hidden", runtime: { cwd: "/tmp/catalog", sessionDir: "/tmp/catalog/sessions" } } };

describe("PiOrbitCatalogService", () => {
  it("parses the complete provider and model catalog", async () => {
    const manager = { getCatalog: vi.fn(async () => ({
      schemaVersion: 1 as const,
      providers: [{
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        auth: { apiKey: true, oauth: false, subscription: false, configured: true },
        models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4", api: "anthropic-messages", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 }],
      }],
    })) };
    const service = new PiOrbitCatalogService(manager, () => options);

    await expect(service.getCatalog()).resolves.toMatchObject({ schemaVersion: 1, providers: [{ id: "anthropic", models: [{ input: ["text", "image"], contextWindow: 200000 }] }] });
    expect(manager.getCatalog).toHaveBeenCalledTimes(1);
  });

  it("folds split runtime providers back onto their canonical provider", async () => {
    const model = (id: string) => ({ id, name: id, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 });
    const manager = { getCatalog: vi.fn(async () => ({
      schemaVersion: 1 as const,
      providers: [
        { id: "user-lab--ep-a", name: "Lab", baseUrl: "http://127.0.0.1:8001/v1", auth: { apiKey: true, oauth: false, subscription: false, configured: true }, models: [model("model-a")] },
        { id: "user-lab--ep-b", name: "Lab", baseUrl: "http://127.0.0.1:8002/v1", auth: { apiKey: true, oauth: false, subscription: false, configured: true }, models: [model("model-b")] },
      ],
    })) };
    const service = new PiOrbitCatalogService(manager, () => options, () => ["user-lab"]);

    await expect(service.getCatalog()).resolves.toMatchObject({
      schemaVersion: 1,
      providers: [{ id: "user-lab", baseUrl: null, models: [{ id: "model-a" }, { id: "model-b" }] }],
    });
  });

  it("rejects an unsupported catalog schema", async () => {
    const manager = { getCatalog: vi.fn(async () => ({ schemaVersion: 2 as const, providers: [] })) } as unknown as Pick<PiManager, "getCatalog">;
    const service = new PiOrbitCatalogService(manager, () => options);

    await expect(service.getCatalog()).rejects.toMatchObject({ code: "runtime_catalog_incompatible" });
  });

  it("does not expose credentials from the catalog response", async () => {
    const manager = { getCatalog: vi.fn(async () => ({
      schemaVersion: 1 as const,
      providers: [{ id: "local", name: "Local", baseUrl: null, auth: { apiKey: true, oauth: false, subscription: false, configured: false }, models: [] }],
      secret: "must-not-escape",
    })) };
    const service = new PiOrbitCatalogService(manager, () => options);
    const result = await service.getCatalog();

    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });
});
