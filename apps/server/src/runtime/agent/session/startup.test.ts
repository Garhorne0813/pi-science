import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenModel } from "./startup.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-open-model-"));
  vi.stubEnv("PI_SCIENCE_HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

type Catalog = Parameters<typeof resolveOpenModel>[2];

function catalog(entries: string[]): Catalog {
  const available = new Set(entries);
  return {
    getModel: (provider: string, modelId: string) =>
      available.has(`${provider}/${modelId}`) ? ({ provider, id: modelId } as never) : undefined,
    getAvailable: async () =>
      [...available].map((entry) => {
        const index = entry.indexOf("/");
        return { provider: entry.slice(0, index), id: entry.slice(index + 1) } as never;
      }),
  } as unknown as Catalog;
}

const ref = (provider: string, modelId: string) => ({ provider, modelId });

describe("resolveOpenModel", () => {
  it("keeps an available persisted selection", async () => {
    await expect(
      resolveOpenModel(
        ref("deepseek", "deepseek-v4-pro"),
        ref("deepseek", "deepseek-flash"),
        catalog(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]),
      ),
    ).resolves.toEqual(ref("deepseek", "deepseek-v4-pro"));
  });

  it("adopts the renamed successor of a retired persisted selection", async () => {
    await expect(
      resolveOpenModel(
        ref("deepseek", "deepseek-v4-flash"),
        ref("deepseek", "deepseek-v4-pro"),
        catalog(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]),
      ),
    ).resolves.toEqual(ref("deepseek", "deepseek-flash"));
  });

  it("uses the requested default when the persisted model left the catalog", async () => {
    await expect(
      resolveOpenModel(
        ref("lab", "retired-model"),
        ref("deepseek", "deepseek-v4-pro"),
        catalog(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]),
      ),
    ).resolves.toEqual(ref("deepseek", "deepseek-v4-pro"));
  });

  it("falls back to the first available model when both selections are gone", async () => {
    await expect(
      resolveOpenModel(
        ref("lab", "retired-model"),
        ref("lab", "also-retired"),
        catalog(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]),
      ),
    ).resolves.toEqual(ref("deepseek", "deepseek-flash"));
  });

  it("returns null when the catalog is empty", async () => {
    await expect(
      resolveOpenModel(ref("lab", "retired-model"), null, catalog([])),
    ).resolves.toBeNull();
  });
});
