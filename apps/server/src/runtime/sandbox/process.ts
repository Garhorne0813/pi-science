import { mkdtemp, mkdir, rm, writeFile, stat, realpath, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { identifyPolicy, isWithin, type SandboxPolicy } from "./policy.js";
import { processSettings, srtCli, type RuntimeInstallation } from "./settings.js";
import { prepareMacosSupervisor } from "./platform.js";

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const launcherPath = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./launcher.ts" : "./launcher.js", import.meta.url));
export interface PreparedSandbox { manifest: string; shell: string; env: Record<string, string>; cleanup(): Promise<void> }
export async function prepareSandbox(policy: SandboxPolicy, argv: string[], dependencies: string[], timeoutSeconds: number, kernelBridge?: string, installation?: RuntimeInstallation, scopedEnvironment: Record<string, string> = {}): Promise<PreparedSandbox> {
  const control = await mkdtemp(join(await realpath(process.platform === "darwin" ? "/private/tmp" : "/tmp"), "ps-exec-"));
  try {
    for (const root of [...policy.readPaths, ...policy.writePaths, ...dependencies]) {
      if (isWithin(await realpath(root), control)) throw new Error("Sandbox grants overlap the private launcher control directory");
    }
    const scratch = join(control, "scratch"); await mkdir(scratch, { mode: 0o700 });
    const settings = await processSettings(identifyPolicy({ ...policy, readPaths: [...policy.readPaths, scratch], writePaths: [...policy.writePaths, scratch] }), dependencies, installation);
    const lifecycleTag = `pi-science.lifecycle.${randomUUID()}`;
    const deniedLifecycleTag = `pi-science.lifecycle.${randomUUID()}`;
    if (process.platform === "darwin") Object.assign(settings.network, { allowMachLookup: [lifecycleTag] });
    const bins: string[] = [];
    for (const path of dependencies) if ((await stat(path)).isDirectory()) bins.push(join(path, "bin"));
    if (dependencies.includes(process.execPath)) bins.unshift(dirname(process.execPath));
    const scoped = Object.fromEntries(Object.entries(scopedEnvironment).filter(([key]) => !/^(?:https?|all|no)_proxy$/i.test(key)));
    let certificate: string | undefined;
    for (const source of process.platform === "darwin" ? ["/etc/ssl/cert.pem"] : ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"]) {
      try { certificate = join(scratch, "system-ca.pem"); await copyFile(source, certificate); break; }
      catch (error) { certificate = undefined; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const env = { ...scoped, PATH: [...bins, "/usr/bin", "/bin"].join(":"), HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      XDG_CACHE_HOME: scratch, MPLCONFIGDIR: scratch, LANG: "C.UTF-8", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", PYTHONNOUSERSITE: "1", NODE_USE_ENV_PROXY: "1",
      ...(certificate ? { SSL_CERT_FILE: certificate, CURL_CA_BUNDLE: certificate, REQUESTS_CA_BUNDLE: certificate, NODE_EXTRA_CA_CERTS: certificate } : {}) };
    const settingsPath = join(control, "settings.json"); const manifest = join(control, "launch.json"); const shell = join(control, "bash");
    await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    const supervisor = await prepareMacosSupervisor(control);
    await writeFile(manifest, JSON.stringify({ cli: srtCli, settings: settingsPath, argv, env, timeoutSeconds, kernelBridge, supervisor, lifecycleTag, deniedLifecycleTag }), { mode: 0o600 });
    await writeFile(shell, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(launcherPath)} ${shellQuote(manifest)} "$@"\n`, { mode: 0o700 });
    // srt's own temporary/proxy state is separate from the code's scratch directory.
    return { manifest, shell, env: { PATH: "/usr/bin:/bin", HOME: control, TMPDIR: control, LANG: "C.UTF-8" }, cleanup: () => rm(control, { recursive: true, force: true }) };
  } catch (error) { await rm(control, { recursive: true, force: true }); throw error; }
}
export function killSandboxGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
