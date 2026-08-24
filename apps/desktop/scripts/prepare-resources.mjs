import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { copyCompanionNodeModules, findCompanionNodeModules } from "../dist/prepare-resources.js";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(desktopRoot, "../..");
const stageRoot = join(desktopRoot, ".stage", "desktop-runtime");
const serverRoot = join(stageRoot, "server");

async function requirePath(path, label) {
  try { await stat(path); }
  catch { throw new Error(`${label} is missing: ${path}. Run pnpm build and install the Pi runtime first.`); }
}

await Promise.all([
  requirePath(join(projectRoot, "frontend", "dist", "index.html"), "frontend build"),
  requirePath(join(projectRoot, "apps", "server", "dist", "launcher", "launcher.js"), "server build"),
  requirePath(join(desktopRoot, "src", "server-runner.cjs"), "desktop server runner"),
  requirePath(join(projectRoot, "runtime", "pi", ".cli-path"), "Pi Orbit marker"),
]);

const sourceRuntimeRoot = join(projectRoot, "runtime", "pi");
const sourceCliValue = (await readFile(join(sourceRuntimeRoot, ".cli-path"), "utf8")).trim();
if (!sourceCliValue) throw new Error(`Pi Orbit marker is empty: ${join(sourceRuntimeRoot, ".cli-path")}`);
const sourceCli = resolve(sourceCliValue);
await requirePath(sourceCli, "Pi Orbit executable");
const companionNodeModules = findCompanionNodeModules(sourceCli, sourceRuntimeRoot);

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const deployed = spawnSync(pnpm, ["--filter", "@pi-science/server", "deploy", "--prod", serverRoot], { cwd: projectRoot, stdio: "inherit" });
if (deployed.status !== 0) throw new Error(`pnpm deploy failed with exit code ${deployed.status ?? "unknown"}`);

await Promise.all([
  cp(join(projectRoot, "frontend", "dist"), join(stageRoot, "frontend"), { recursive: true }),
  cp(join(projectRoot, "harness"), join(stageRoot, "harness"), { recursive: true }),
  cp(join(projectRoot, "skills"), join(stageRoot, "skills"), { recursive: true }),
  cp(join(projectRoot, "apps", "server", "src", "runtime", "pi", "extensions"), join(stageRoot, "apps", "server", "src", "runtime", "pi", "extensions"), { recursive: true }),
  cp(join(desktopRoot, "src", "server-runner.cjs"), join(stageRoot, "server-runner.cjs")),
]);

const packagedCliDir = join(stageRoot, "runtime", "pi", "pi-orbit");
await mkdir(dirname(packagedCliDir), { recursive: true });
await cp(dirname(sourceCli), packagedCliDir, { recursive: true });
const relativeCli = relative(stageRoot, join(packagedCliDir, basename(sourceCli)));
await writeFile(join(stageRoot, "runtime", "pi", ".cli-path-relative"), `${relativeCli}\n`, "utf8");

await copyCompanionNodeModules(companionNodeModules, join(stageRoot, "runtime", "pi"));
const stagedProviderCatalog = join(stageRoot, "runtime", "pi", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js");
try {
  const { builtinProviders } = await import(pathToFileURL(stagedProviderCatalog).href);
  const providers = typeof builtinProviders === "function" ? builtinProviders() : [];
  if (!Array.isArray(providers) || providers.length === 0) throw new Error("catalog returned no providers");
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`Pi Orbit provider catalog is unusable in the packaged resource root: ${detail}`);
}

await writeFile(join(stageRoot, "runtime-manifest.json"), `${JSON.stringify({
  schema_version: 1,
  platform: process.platform,
  arch: process.arch,
  pi_cli: relativeCli,
  created_at: new Date().toISOString(),
}, null, 2)}\n`, "utf8");

console.log(`Desktop runtime staged at ${stageRoot}`);
