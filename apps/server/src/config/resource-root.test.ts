import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app/app.js";
import type { ServerConfig } from "./config.js";
import { loadPiAiCatalog } from "./model-catalog-fallback.js";
import { hasEnvApiKey, loadPiAiProviderCatalog } from "./pi-ai-provider-catalog.js";

const originalResourceRoot = process.env.PI_SCIENCE_RESOURCE_ROOT;
const originalFakeKey = process.env.FAKE_DESKTOP_API_KEY;
const temporaryRoots: string[] = [];

afterEach(async () => {
  if (originalResourceRoot === undefined) delete process.env.PI_SCIENCE_RESOURCE_ROOT;
  else process.env.PI_SCIENCE_RESOURCE_ROOT = originalResourceRoot;
  if (originalFakeKey === undefined) delete process.env.FAKE_DESKTOP_API_KEY;
  else process.env.FAKE_DESKTOP_API_KEY = originalFakeKey;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeDesktopResourceRoot(withEnvKeyAdapter = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-science-resource-root-"));
  temporaryRoots.push(root);
  const dist = join(root, "runtime", "pi", "node_modules", "@earendil-works", "pi-ai", "dist");
  await mkdir(join(dist, "providers"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(dist, "providers", "all.js"), `
    export const builtinProviders = () => [{
      id: "desktop-test",
      name: "Desktop Test",
      auth: { apiKey: "FAKE_DESKTOP_API_KEY" },
      getModels: () => [{ id: "desktop-model" }],
    }];
  `);
  if (withEnvKeyAdapter) await writeFile(join(dist, "env-api-keys.js"), `
    export function getEnvApiKey(_provider, env) {
      return env.FAKE_DESKTOP_API_KEY;
    }
  `);
  await writeFile(join(dist, "models.generated.js"), `
    export const MODELS = {
      "desktop-test": [{ id: "desktop-model", name: "Desktop Model" }],
    };
  `);
  return root;
}

describe("packaged resource root", () => {
  it("loads the provider inventory and environment-key adapter from PI_SCIENCE_RESOURCE_ROOT", async () => {
    process.env.PI_SCIENCE_RESOURCE_ROOT = await fakeDesktopResourceRoot();
    process.env.FAKE_DESKTOP_API_KEY = "secret-test-value";

    await expect(loadPiAiProviderCatalog()).resolves.toEqual([
      {
        id: "desktop-test",
        name: "Desktop Test",
        apiKeySupported: true,
        oauthSupported: false,
        subscription: false,
        modelIds: ["desktop-model"],
      },
    ]);
    await expect(hasEnvApiKey("desktop-test")).resolves.toBe(true);
  });

  it("keeps the provider inventory available when the optional env-key adapter is absent", async () => {
    process.env.PI_SCIENCE_RESOURCE_ROOT = await fakeDesktopResourceRoot(false);

    await expect(loadPiAiProviderCatalog()).resolves.toEqual([
      {
        id: "desktop-test",
        name: "Desktop Test",
        apiKeySupported: true,
        oauthSupported: false,
        subscription: false,
        modelIds: ["desktop-model"],
      },
    ]);
    await expect(hasEnvApiKey("desktop-test")).resolves.toBe(false);
  });

  it("loads the generated model catalog from PI_SCIENCE_RESOURCE_ROOT", async () => {
    process.env.PI_SCIENCE_RESOURCE_ROOT = await fakeDesktopResourceRoot();

    await expect(loadPiAiCatalog()).resolves.toEqual([
      { provider: "desktop-test", id: "desktop-model", name: "Desktop Model" },
    ]);
  });

  it("serves a non-empty provider inventory from the packaged resource root", async () => {
    process.env.PI_SCIENCE_RESOURCE_ROOT = await fakeDesktopResourceRoot();
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      corsOrigins: [],
      maxBodyBytes: 10 * 1024 * 1024,
      upstreamTimeoutMs: 1_000,
      nodeSessions: false,
      nodeSse: false,
      nodeFiles: false,
      nodePiManager: false,
      nodeJobs: false,
      nodeArtifacts: false,
      nodeSettings: true,
      nodeCatalog: false,
      nodeProject: false,
      nodeLiterature: false,
      nodeExecutions: false,
      logLevel: "silent",
    };
    const app = buildApp(config);
    try {
      const response = await app.inject({ method: "GET", url: "/api/settings/providers" });
      expect(response.statusCode).toBe(200);
      expect(response.json().providers).toEqual([
        expect.objectContaining({ id: "desktop-test", models: ["desktop-model"] }),
      ]);
    } finally {
      await app.close();
    }
  });
});
