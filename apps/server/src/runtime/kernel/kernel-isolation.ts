import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { configPath, configRoot } from "../../storage/persistence.js";

export const KERNEL_ISOLATION_POLICIES = ["workspace", "workspace-network", "unconfined"] as const;
export type KernelIsolationPolicy = (typeof KERNEL_ISOLATION_POLICIES)[number];
export const DEFAULT_KERNEL_ISOLATION: KernelIsolationPolicy = "workspace";

export interface KernelLaunchRequest {
  platform: NodeJS.Platform;
  workspace: string;
  environmentPrefix: string;
  interpreter: string;
  bridge: string;
  codeFile?: string;
  env: NodeJS.ProcessEnv;
}

export interface KernelLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

export class KernelIsolationUnavailableError extends Error {
  constructor(policy: KernelIsolationPolicy, readonly platform: NodeJS.Platform, reason: string) {
    super(`Kernel isolation policy "${policy}" cannot be enforced on ${platform}: ${reason}. No kernel was started. Set PI_SCIENCE_KERNEL_ISOLATION=unconfined to run kernels without OS isolation, or run the server on macOS, where the profile is enforced.`);
    this.name = "KernelIsolationUnavailableError";
  }
}

type CanonicalPath = string & { readonly __canonical: unique symbol };
interface PathRule { effect: "allow" | "deny"; operation: "file-read*" | "file-write*"; selector: "literal" | "subpath"; paths: CanonicalPath[] }
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

async function canonicalize(path: string): Promise<CanonicalPath> {
  const absolute = resolve(path);
  try { return await realpath(absolute) as CanonicalPath; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(absolute) === absolute) throw error;
    return join(await canonicalize(dirname(absolute)), basename(absolute)) as CanonicalPath;
  }
}

function sbplLiteral(path: CanonicalPath): string { return JSON.stringify(path); }

function profile(policy: KernelIsolationPolicy, rules: PathRule[]): string {
  return [
    "(version 1)", "(deny default)", "(allow process-exec*)", "(allow process-fork)", "(allow sysctl-read)", "(allow file-read-metadata)",
    '(allow mach-lookup (global-name "com.apple.system.notification_center"))',
    '(allow ipc-posix-shm-read-data (global-name "apple.shm.notification_center"))',
    ...rules.filter((rule) => rule.paths.length > 0).map((rule) => `(${rule.effect} ${rule.operation} ${rule.paths.map((path) => `(${rule.selector} ${sbplLiteral(path)})`).join(" ")})`),
    policy === "workspace-network" ? "(allow network*)" : "(deny network*)",
  ].join("\n");
}

export async function planKernelLaunch(policy: KernelIsolationPolicy, request: KernelLaunchRequest): Promise<KernelLaunch> {
  const args = [request.bridge, ...(request.codeFile ? [request.codeFile] : [])];
  if (policy === "unconfined") return { command: request.interpreter, args, env: request.env, dispose: async () => undefined };
  if (request.platform !== "darwin") throw new KernelIsolationUnavailableError(policy, request.platform, "no OS enforcer is available");
  try { await access(SANDBOX_EXEC, constants.X_OK); }
  catch { throw new KernelIsolationUnavailableError(policy, request.platform, `${SANDBOX_EXEC} is missing or not executable`); }

  const hash = createHash("sha256").update([request.workspace, randomUUID()].join("\0")).digest("hex").slice(0, 20);
  const scratchPath = configPath(join("kernel-scratch", hash));
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= rm(scratchPath, { recursive: true, force: true });
  try {
    await Promise.all(["tmp", "matplotlib", "cache"].map((name) => mkdir(join(scratchPath, name), { recursive: true })));
    const interpreter = await canonicalize(request.interpreter);
    const packageRoot = ["/opt/homebrew", "/usr/local"].find((root) => interpreter.startsWith(`${root}/`));
    const runtime = await Promise.all([request.environmentPrefix, dirname(dirname(interpreter)), ...(packageRoot ? ["Cellar", "opt", "lib"].map((name) => join(packageRoot, name)) : [])].map(canonicalize));
    const [workspace, scratch, appState, metadata] = await Promise.all([request.workspace, scratchPath, configRoot(), join(request.workspace, ".pi-science")].map(canonicalize));
    const hostFiles = await Promise.all([request.bridge, ...(request.codeFile ? [request.codeFile] : [])].map(canonicalize));
    const system = await Promise.all(["/usr/lib", "/usr/share", "/System", "/Library", "/private/var/db"].map(canonicalize));
    const devices = await Promise.all(["/", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/dtracehelper"].map(canonicalize));
    const dtrace = await canonicalize("/dev/dtracehelper");
    // A program expects to open /dev/null for writing, and subprocess.DEVNULL does exactly that.
    const nullDevice = await canonicalize("/dev/null");
    // Later matching rules override earlier ones; the final grants preserve the runtime carve-outs.
    const rules: PathRule[] = [
      { effect: "allow", operation: "file-read*", selector: "subpath", paths: system },
      { effect: "allow", operation: "file-read*", selector: "literal", paths: devices },
      { effect: "allow", operation: "file-write*", selector: "literal", paths: [nullDevice!, dtrace] },
      { effect: "allow", operation: "file-read*", selector: "subpath", paths: [workspace!] },
      { effect: "allow", operation: "file-write*", selector: "subpath", paths: [workspace!] },
      { effect: "allow", operation: "file-read*", selector: "subpath", paths: runtime },
      { effect: "allow", operation: "file-read*", selector: "literal", paths: hostFiles },
      { effect: "allow", operation: "file-read*", selector: "subpath", paths: [scratch!] },
      { effect: "allow", operation: "file-write*", selector: "subpath", paths: [scratch!] },
      { effect: "deny", operation: "file-read*", selector: "subpath", paths: [appState!, metadata!] },
      { effect: "deny", operation: "file-write*", selector: "subpath", paths: [appState!, metadata!, ...runtime] },
      { effect: "allow", operation: "file-read*", selector: "subpath", paths: runtime },
      { effect: "allow", operation: "file-read*", selector: "literal", paths: hostFiles },
      { effect: "allow", operation: "file-read*", selector: "subpath", paths: [scratch!] },
      { effect: "allow", operation: "file-write*", selector: "subpath", paths: [scratch!] },
    ];
    const env = { ...request.env };
    for (const key of Object.keys(env)) if (key === "PI_SCIENCE_INTERNAL_TOKEN" || /_(API_KEY|KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/.test(key.toUpperCase())) delete env[key];
    const [tmp, matplotlib, cache] = await Promise.all(["tmp", "matplotlib", "cache"].map((name) => canonicalize(join(scratch!, name))));
    Object.assign(env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp, MPLCONFIGDIR: matplotlib, XDG_CACHE_HOME: cache });
    return { command: SANDBOX_EXEC, args: ["-p", profile(policy, rules), request.interpreter, ...args], env, dispose };
  } catch (error) { await dispose(); throw error; }
}
