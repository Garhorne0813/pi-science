import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { identifyPolicy, type SandboxPolicy } from "./policy.js";
import { processSettings, srtCli, type RuntimeInstallation } from "./settings.js";

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const launcherPath = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./launcher.ts" : "./launcher.js", import.meta.url));
export interface PreparedSandbox { manifest: string; shell: string; env: Record<string, string>; cleanup(): Promise<void> }
export async function prepareSandbox(policy: SandboxPolicy, argv: string[], dependencies: string[], timeoutSeconds: number, kernelBridge?: string, installation?: RuntimeInstallation): Promise<PreparedSandbox> {
  const control = await mkdtemp(join(tmpdir(), "pi-science-execution-"));
  try {
    const scratch = join(control, "scratch"); await mkdir(scratch, { mode: 0o700 });
    const settings = await processSettings(identifyPolicy({ ...policy, readPaths: [...policy.readPaths, scratch], writePaths: [...policy.writePaths, scratch] }), dependencies, installation);
    const bins: string[] = [];
    for (const path of dependencies) if ((await stat(path)).isDirectory()) bins.push(join(path, "bin"));
    const env = { PATH: [...bins, "/usr/bin", "/bin"].join(":"), HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      XDG_CACHE_HOME: scratch, MPLCONFIGDIR: scratch, LANG: "C.UTF-8", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", PYTHONNOUSERSITE: "1" };
    const settingsPath = join(control, "settings.json"); const manifest = join(control, "launch.json"); const shell = join(control, "bash");
    await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    await writeFile(manifest, JSON.stringify({ cli: srtCli, settings: settingsPath, argv, env, timeoutSeconds, kernelBridge }), { mode: 0o600 });
    await writeFile(shell, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(launcherPath)} ${shellQuote(manifest)} "$@"\n`, { mode: 0o700 });
    // srt's own temporary/proxy state is separate from the code's scratch directory.
    return { manifest, shell, env: { PATH: "/usr/bin:/bin", HOME: control, TMPDIR: control, LANG: "C.UTF-8" }, cleanup: () => rm(control, { recursive: true, force: true }) };
  } catch (error) { await rm(control, { recursive: true, force: true }); throw error; }
}
export function killSandboxGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
