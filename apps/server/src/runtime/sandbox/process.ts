import { writeSandboxCaBundle } from "./certificates.js";
import { networkApprovalEndpoint } from "./network-approval-channel.js";
import { networkGrantsPath } from "./network-grants.js";
import { mkdtemp, mkdir, rm, writeFile, stat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { requireSandboxPlatform } from "./platform.js";
import { canonicalDirectory, identifyPolicy, isWithin, type SandboxPolicy } from "./policy.js";
import { processSettings, srtCli, type RuntimeInstallation } from "./settings.js";
import { prepareMacosSupervisor } from "./platform.js";

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const launcherPath = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./launcher.ts" : "./launcher.js", import.meta.url),
);
export interface PreparedSandbox {
  manifest: string;
  shell: string;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}
export async function prepareSandbox(
  policy: SandboxPolicy,
  argv: string[],
  dependencies: string[],
  timeoutSeconds: number,
  kernelBridge?: string,
  installation?: RuntimeInstallation,
  scopedEnvironment: Record<string, string> = {},
  approvalIdentity?: { cwd: string; sessionId: string; contextId?: string },
): Promise<PreparedSandbox> {
  const networkGrants =
    policy.scope === "workspace" && (policy.profile === "analysis" || policy.profile === "mcp")
      ? { path: networkGrantsPath(), profile: policy.profile }
      : undefined;
  if (
    networkGrants &&
    policy.writePaths.some((root) => isWithin(root, dirname(networkGrants.path))) &&
    !policy.denyPaths.some((root) => isWithin(root, dirname(networkGrants.path)))
  )
    throw new Error("Network permissions must be outside writable sandbox paths");
  const identity =
    approvalIdentity ??
    (policy.approval ? { cwd: policy.cwd, sessionId: policy.approval.sessionId } : undefined);
  const endpoint =
    networkGrants && identity
      ? await networkApprovalEndpoint(identity.cwd, identity.sessionId)
      : undefined;
  const networkApproval = endpoint ? { ...endpoint, contextId: identity?.contextId } : undefined;
  // Reject unsupported platforms before allocating a control directory. On
  // Windows TEMP is inside HOME, which a full-access policy intentionally grants.
  requireSandboxPlatform();
  const control = await mkdtemp(
    join(await realpath(process.platform === "darwin" ? "/private/tmp" : "/tmp"), "ps-exec-"),
  );
  try {
    for (const root of [...policy.readPaths, ...policy.writePaths, ...dependencies]) {
      if (isWithin(await realpath(root), control))
        throw new Error("Sandbox grants overlap the private launcher control directory");
    }
    if (networkGrants) await canonicalDirectory(dirname(networkGrants.path));
    const scratch = join(control, "scratch");
    await mkdir(scratch, { mode: 0o700 });
    const settings = await processSettings(
      identifyPolicy({
        ...policy,
        readPaths: [...policy.readPaths, scratch],
        writePaths: [...policy.writePaths, scratch],
      }),
      dependencies,
      installation,
    );
    const lifecycleTag = `pi-science.lifecycle.${randomUUID()}`;
    const deniedLifecycleTag = `pi-science.lifecycle.${randomUUID()}`;
    if (process.platform === "darwin")
      Object.assign(settings.network, { allowMachLookup: [lifecycleTag] });
    const bins: string[] = [];
    for (const path of dependencies)
      if ((await stat(path)).isDirectory()) bins.push(join(path, "bin"));
    if (dependencies.includes(process.execPath)) bins.unshift(dirname(process.execPath));
    const scoped = Object.fromEntries(
      Object.entries(scopedEnvironment).filter(
        ([key]) => !/^(?:(?:https?|all|no)_proxy|PI_SCIENCE_SANDBOX_HTTP_PROXY)$/i.test(key),
      ),
    );
    const certificate = await writeSandboxCaBundle(scratch);
    const env = {
      ...scoped,
      PATH: [...bins, "/usr/bin", "/bin"].join(":"),
      HOME: scratch,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      XDG_CACHE_HOME: scratch,
      MPLCONFIGDIR: scratch,
      LANG: "C.UTF-8",
      OPENBLAS_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
      PYTHONNOUSERSITE: "1",
      NODE_USE_ENV_PROXY: "1",
      SSL_CERT_FILE: certificate,
      CURL_CA_BUNDLE: certificate,
      REQUESTS_CA_BUNDLE: certificate,
      NODE_EXTRA_CA_CERTS: certificate,
      ...(policy.profile === "install"
        ? { MAMBA_SSL_VERIFY: certificate, CONDA_SSL_VERIFY: certificate }
        : {}),
    };
    const settingsPath = join(control, "settings.json");
    const manifest = join(control, "launch.json");
    const shell = join(control, "bash");
    await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    const supervisor = await prepareMacosSupervisor(control);
    await writeFile(
      manifest,
      JSON.stringify({
        cli: srtCli,
        settings: settingsPath,
        argv,
        env,
        timeoutSeconds,
        kernelBridge,
        supervisor,
        lifecycleTag,
        deniedLifecycleTag,
        networkGrants,
        networkApproval,
        networkPolicy: policy.network,
        executionGrant: policy.executionGrant,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      shell,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(launcherPath)} ${shellQuote(manifest)} "$@"\n`,
      { mode: 0o700 },
    );
    // srt's own temporary/proxy state is separate from the code's scratch directory.
    return {
      manifest,
      shell,
      env: { PATH: "/usr/bin:/bin", HOME: control, TMPDIR: control, LANG: "C.UTF-8" },
      cleanup: () => rm(control, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(control, { recursive: true, force: true });
    throw error;
  }
}
export function killSandboxGroup(
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

const runFile = promisify(execFile);
export async function retireSandboxGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined) return; // A failed spawn never created a process group.
  killSandboxGroup(pid);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    // A reparented zombie may outlive its leader until init reaps it. It cannot
    // execute code; all other group members must be confirmed stopped. ps works
    // on both supported POSIX platforms without exposing command arguments.
    const { stdout } = await runFile("/bin/ps", ["-A", "-o", "pgid=,stat="], {
      timeout: 1_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const live = stdout
      .trim()
      .split("\n")
      .some((line) => {
        const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
        if (!match) throw new Error("Unable to verify sandbox process group state");
        return Number(match[1]) === pid && !match[2]!.startsWith("Z");
      });
    if (!live) return;
    if (Date.now() >= deadline)
      throw new Error("Sandbox process group retirement was not confirmed");
    await delay(25);
  }
}
