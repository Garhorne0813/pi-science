import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore } from "./settings-store.js";

const roots: string[] = [];
const originalHome = process.env.PI_SCIENCE_HOME;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SettingsStore", () => {
  it("serves isolated cached reads and refreshes the cache after updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-settings-store-"));
    roots.push(root);
    process.env.PI_SCIENCE_HOME = root;
    const store = new SettingsStore();

    await store.update((settings) => { settings.model = "provider/first"; });
    const first = await store.read();
    first.model = "mutated/by/caller";
    expect((await store.read()).model).toBe("provider/first");

    await store.update((settings) => { settings.model = "provider/second"; });
    expect((await store.read()).model).toBe("provider/second");
  });
});
