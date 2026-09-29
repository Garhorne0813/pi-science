import { describe, expect, it, vi } from "vitest";
import { PiRuntimeCatalogError, PiRuntimeCatalogService, withoutProjectedUserProviders, type PiRuntimeCatalog } from "./pi-runtime-catalog.js";

/** The service only reads providers, models, and the configured-auth flag, so a
 *  structural fake is enough here and keeps this test independent of the real
 *  pi-ai/pi-coding-agent runtime. */
type FakeModelRuntime = {
  getProviders(): unknown[];
  getModels(providerId: string): unknown[];
  hasConfiguredAuth(providerId: string): boolean;
};

type FakeProvider = {
  id: string;
  name: string;
  baseUrl?: string;
  auth: { apiKey?: { key: string }; oauth?: { token: string; isSubscription?: boolean } };
};

type FakeModel = {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: string[];
  contextWindow: number;
  maxTokens: number;
};

/** A provider/model set that exercises every auth and thinking-level branch the
 *  catalog maps. `getModels` is keyed by provider id. */
const PROVIDERS: FakeProvider[] = [
  { id: "openrouter", name: "OpenRouter", auth: { apiKey: { key: "sk-openrouter" } } },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", auth: { oauth: { token: "oauth-token", isSubscription: true } } },
  { id: "user-lab", name: "Lab", baseUrl: "http://127.0.0.1:8000/v1", auth: { apiKey: { key: "lab-key" } } },
  { id: "user-lab--ep-a", name: "Lab", baseUrl: "http://127.0.0.1:8001/v1", auth: { apiKey: { key: "lab-key" } } },
];

const MODELS: Record<string, FakeModel[]> = {
  openrouter: [{ id: "openai/gpt-5.1", name: "GPT-5.1", api: "openai-completions", reasoning: true, thinkingLevelMap: { off: "off", low: "low", high: "high", xhigh: "xhigh" }, input: ["text", "image"], contextWindow: 400_000, maxTokens: 128_000 }],
  anthropic: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4", api: "anthropic-messages", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 64_000 }],
  "user-lab": [{ id: "model-a", name: "Lab · model-a", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096 }],
  "user-lab--ep-a": [{ id: "remote-model-a", name: "Lab · model-a", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096 }],
};

function fakeRuntime(overrides: Partial<FakeModelRuntime> = {}): FakeModelRuntime & { getProviders: ReturnType<typeof vi.fn>; getModels: ReturnType<typeof vi.fn> } {
  return {
    getProviders: vi.fn(() => PROVIDERS),
    getModels: vi.fn((providerId: string) => MODELS[providerId] ?? []),
    hasConfiguredAuth: vi.fn((providerId: string) => providerId !== "anthropic"),
    ...overrides,
  } as FakeModelRuntime & { getProviders: ReturnType<typeof vi.fn>; getModels: ReturnType<typeof vi.fn> };
}

function catalogService(factory: () => Promise<FakeModelRuntime>, canonicalIds: readonly string[] = []): PiRuntimeCatalogService {
  // `as never`: the injected factory is only required to be structurally
  // compatible with the default runtime factory at runtime.
  return new PiRuntimeCatalogService(factory as never, () => canonicalIds);
}

describe("Pi runtime catalog", () => {
  it("maps providers, auth flags, and thinking levels into the catalog shape", async () => {
    const service = catalogService(async () => fakeRuntime());

    const catalog = await service.getCatalog();

    expect(catalog).toEqual({
      schemaVersion: 1,
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          baseUrl: null,
          auth: { apiKey: true, oauth: false, subscription: false, configured: true },
          models: [{
            id: "openai/gpt-5.1",
            name: "GPT-5.1",
            api: "openai-completions",
            reasoning: true,
            // getSupportedThinkingLevels on a mapped reasoning model reports
            // every non-null level, so the catalog mirrors the runtime rather
            // than a second, Pi-Science-specific level list.
            thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
            input: ["text", "image"],
            contextWindow: 400_000,
            maxTokens: 128_000,
          }],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          baseUrl: "https://api.anthropic.com",
          auth: { apiKey: false, oauth: true, subscription: true, configured: false },
          models: [{
            id: "claude-sonnet-4",
            name: "Claude Sonnet 4",
            api: "anthropic-messages",
            reasoning: false,
            thinkingLevels: ["off"],
            input: ["text"],
            contextWindow: 200_000,
            maxTokens: 64_000,
          }],
        },
        {
          id: "user-lab",
          name: "Lab",
          baseUrl: "http://127.0.0.1:8000/v1",
          auth: { apiKey: true, oauth: false, subscription: false, configured: true },
          models: [{
            id: "model-a",
            name: "Lab · model-a",
            api: "openai-completions",
            reasoning: false,
            thinkingLevels: ["off"],
            input: ["text"],
            contextWindow: 32_768,
            maxTokens: 4_096,
          }],
        },
        {
          id: "user-lab--ep-a",
          name: "Lab",
          baseUrl: "http://127.0.0.1:8001/v1",
          auth: { apiKey: true, oauth: false, subscription: false, configured: true },
          models: [{
            id: "remote-model-a",
            name: "Lab · model-a",
            api: "openai-completions",
            reasoning: false,
            thinkingLevels: ["off"],
            input: ["text"],
            contextWindow: 32_768,
            maxTokens: 4_096,
          }],
        },
      ],
    });
  });

  it("drops the projected runtime aliases of canonical user providers", async () => {
    const service = catalogService(async () => fakeRuntime(), ["user-lab"]);

    const catalog = await service.getCatalog();

    // The canonical providers are exposed by the control plane, so neither the
    // canonical id nor its route-local projection is a catalog provider.
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["openrouter", "anthropic"]);
    expect(catalog.schemaVersion).toBe(1);
  });

  it("creates the runtime once and reads the providers once per catalog load", async () => {
    const runtime = fakeRuntime();
    const factory = vi.fn(async () => runtime);
    const service = catalogService(factory);

    const [first, second] = await Promise.all([service.getCatalog(), service.getCatalog()]);
    const third = await service.getCatalog();

    // Concurrent reads share one in-flight load and one runtime instance.
    expect(runtime.getProviders).toHaveBeenCalledTimes(2);
    expect(first).toEqual(third);
    expect(second).toEqual(third);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("retries a failed runtime creation on the next catalog read", async () => {
    const runtime = fakeRuntime();
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error("runtime is offline"))
      .mockImplementation(async () => runtime);
    const service = catalogService(factory);

    await expect(service.getCatalog()).rejects.toMatchObject({
      name: "PiRuntimeCatalogError",
      code: "runtime_catalog_unavailable",
      message: expect.stringContaining("runtime is offline"),
    });
    await expect(service.getCatalog()).resolves.toMatchObject({ schemaVersion: 1 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("reports an unavailable catalog as a typed failure", async () => {
    const service = catalogService(async () => { throw new Error("no runtime"); });

    const failure = await service.getCatalog().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PiRuntimeCatalogError);
    expect(failure).toMatchObject({ code: "runtime_catalog_unavailable" });
    expect(String((failure as Error).message)).toContain("Pi runtime catalog is unavailable: no runtime");
  });
});

describe("catalog input invalidation", () => {
  it("rebuilds the runtime when a catalog input file changes", async () => {
    let fingerprint = "config:1|credentials:none";
    let builds = 0;
    const service = new PiRuntimeCatalogService(
      (async () => { builds += 1; return fakeRuntime(); }) as never,
      () => [],
      () => fingerprint,
    );

    await service.getCatalog();
    await service.getCatalog();
    expect(builds).toBe(1);

    // Deleting an API key rewrites config.json or the credential store. A
    // cached runtime would keep the deleted secret in auth.json and keep
    // reporting that provider as configured.
    fingerprint = "config:2|credentials:none";
    await service.getCatalog();
    expect(builds).toBe(2);
  });
});

describe("withoutProjectedUserProviders", () => {
  function catalogOf(...ids: string[]): PiRuntimeCatalog {
    return {
      schemaVersion: 1,
      providers: ids.map((id) => ({ id, name: id, baseUrl: null, auth: { apiKey: false, oauth: false, subscription: false, configured: false }, models: [] })),
    };
  }

  it("removes a canonical provider and its --suffixed projections only", () => {
    const filtered = withoutProjectedUserProviders(catalogOf("user-lab", "user-lab--ep-a", "user-lab-other", "userlab--ep", "openrouter"), ["user-lab"]);

    expect(filtered.providers.map((provider) => provider.id)).toEqual(["user-lab-other", "userlab--ep", "openrouter"]);
    expect(filtered.schemaVersion).toBe(1);
  });

  it("returns the same catalog when there is no canonical provider to project", () => {
    const catalog = catalogOf("openrouter", "user-lab--ep-a");

    expect(withoutProjectedUserProviders(catalog, [])).toBe(catalog);
  });
});
