import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProgressAppearance } from "@pi-science/contracts";
import { configPath, writeJsonAtomic } from "./persistence.js";
import { SettingsStore } from "./settings-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.PI_SCIENCE_HOME;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SettingsStore progress recovery", () => {
  it("recovers invalid enum fields without discarding valid progress settings", async () => {
    const home = join(tmpdir(), `pi-science-settings-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(home);
    await mkdir(home, { recursive: true });
    process.env.PI_SCIENCE_HOME = home;

    await writeJsonAtomic(configPath("config.json"), {
      progress_appearance: {
        ...structuredClone(defaultProgressAppearance),
        preset: "removed-preset",
        motion: "reduce",
        colorMode: "brand",
        speed: 1.5,
        customColor: "#123456",
        patterns: { ...defaultProgressAppearance.patterns, currentActivity: "inline-signal" },
      },
    });

    const settings = await new SettingsStore().read();
    expect(settings.progress_appearance).toMatchObject({
      preset: defaultProgressAppearance.preset,
      motion: defaultProgressAppearance.motion,
      colorMode: defaultProgressAppearance.colorMode,
      speed: 1.5,
      customColor: "#123456",
      patterns: expect.objectContaining({ currentActivity: "inline-signal" }),
    });
  });

  it("recovers a malformed patterns container without resetting unrelated fields", async () => {
    const home = join(tmpdir(), `pi-science-settings-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(home);
    await mkdir(home, { recursive: true });
    process.env.PI_SCIENCE_HOME = home;

    await writeJsonAtomic(configPath("config.json"), {
      progress_appearance: {
        ...structuredClone(defaultProgressAppearance),
        preset: "science",
        speed: 1.75,
        patterns: "legacy-patterns",
      },
    });

    const settings = await new SettingsStore().read();
    expect(settings.progress_appearance?.preset).toBe("science");
    expect(settings.progress_appearance?.speed).toBe(1.75);
    expect(settings.progress_appearance?.patterns).toEqual(defaultProgressAppearance.patterns);
  });
});
