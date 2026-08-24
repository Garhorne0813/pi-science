import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyCompanionNodeModules, findCompanionNodeModules, PI_AI_PROVIDER_CATALOG_RELATIVE } from "./prepare-resources.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop resource staging", () => {
  it("finds and copies the provider catalog from the Pi Orbit marker runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-desktop-resources-"));
    temporaryRoots.push(root);
    const checkoutRuntime = join(root, "worktree", "runtime", "pi");
    const installedRuntime = join(root, "installed", "runtime", "pi");
    const sourceCli = join(installedRuntime, "releases", "pi-orbit-0.2.0", "pi-orbit", "pi-orbit");
    const sourceNodeModules = join(installedRuntime, "node_modules");
    const providerCatalog = join(sourceNodeModules, "@earendil-works", "pi-ai", "dist", "providers", "all.js");
    await mkdir(dirname(providerCatalog), { recursive: true });
    await writeFile(providerCatalog, "export const builtinProviders = () => [{ id: 'fixture' }];", "utf8");

    expect(findCompanionNodeModules(sourceCli, checkoutRuntime)).toBe(sourceNodeModules);

    const stagedRuntime = join(root, "stage", "runtime", "pi");
    await copyCompanionNodeModules(sourceNodeModules, stagedRuntime);
    await expect(readFile(join(stagedRuntime, PI_AI_PROVIDER_CATALOG_RELATIVE), "utf8")).resolves.toContain("builtinProviders");
  });

  it("fails the build when the marker runtime has no pi-ai provider catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-desktop-resources-"));
    temporaryRoots.push(root);
    const sourceCli = join(root, "installed", "runtime", "pi", "releases", "pi-orbit", "pi-orbit");

    expect(() => findCompanionNodeModules(sourceCli, join(root, "worktree", "runtime", "pi"))).toThrow(/companion node_modules is missing.*pi-ai.*all\.js/);
  });
});
