import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWithin, type SandboxPolicy } from "./policy.js";

export const SANDBOX_RUNTIME = "@anthropic-ai/sandbox-runtime@0.0.79";
export const srtCli = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime")).replace(/index\.js$/, "cli.js");
export interface RuntimeInstallation { socat?: string; ripgrep?: string }
export function runtimeInstallation(): RuntimeInstallation {
  return { socat: process.env.PI_SCIENCE_SANDBOX_SOCAT, ripgrep: process.env.PI_SCIENCE_SANDBOX_RIPGREP };
}
export function bashDependencies(): string[] {
  const paths: unknown = JSON.parse(process.env.PI_SCIENCE_SANDBOX_RUNTIME_PATHS ?? "[]");
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) throw new Error("Invalid operator sandbox runtime paths");
  return [...new Set([...(paths as string[]), ...(process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT ? [process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT] : [])])];
}
/** Exact-version Linux configuration shared by one-shot and persistent processes. */
export async function processSettings(policy: SandboxPolicy, dependencies: string[], installation = runtimeInstallation()) {
  if (process.platform !== "linux") throw new Error("Sandbox execution is disabled on this platform");
  const root = dirname(dirname(srtCli));
  // Workloads must not rewrite the launcher/service code or its runtime and gain
  // host execution on a later call. A checkout used as the server installation
  // cannot simultaneously be its untrusted writable workspace.
  const serverRoot = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
  for (const trusted of [serverRoot, root, process.execPath]) if (policy.writePaths.some((write) => isWithin(write, trusted) || isWithin(trusted, write))) throw new Error("Writable sandbox paths overlap the trusted server installation");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.version !== "0.0.79") throw new Error("Sandbox runtime version has not been validated");
  if (!["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported sandbox architecture");
  await access(join(root, "vendor/seccomp", process.arch, "apply-seccomp"), constants.X_OK);
  const system = ["/usr/bin", "/usr/lib", "/usr/lib64", "/bin", "/lib", "/lib64", "/etc/ld.so.cache", "/dev/null", "/dev/urandom", "/dev/random"];
  const reads: string[] = [];
  for (const path of system) {
    try { reads.push(await realpath(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const path of dependencies) {
    if (!isAbsolute(path) || path === "/" || ["/home", "/opt", "/usr", "/usr/local"].includes(path)) throw new Error("Dependencies require explicit narrow absolute paths");
    const canonical = await realpath(path);
    if (["/", "/home", "/Users", "/opt", "/usr", "/usr/local"].includes(canonical)) throw new Error("Dependencies require explicit narrow absolute paths");
    if (policy.writePaths.some((write) => isWithin(write, canonical) || isWithin(canonical, write))) throw new Error("Runtime dependencies must be outside writable sandbox paths");
    reads.push(canonical);
  }
  for (const binary of [installation.socat, installation.ripgrep]) if (binary) {
    if (!isAbsolute(binary)) throw new Error("Sandbox helper paths must be absolute");
    const canonical = await realpath(binary);
    if (policy.writePaths.some((write) => isWithin(write, canonical))) throw new Error("Sandbox helpers must be outside writable sandbox paths");
    await access(canonical, constants.X_OK);
  }
  const literal = (path: string) => ({ path, literal: true as const });
  return {
    network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
    filesystem: { denyRead: ["/", ...policy.denyPaths].map(literal), allowRead: [...new Set([...reads, join(root, "vendor/seccomp"), ...(installation.socat ? [installation.socat] : []), ...policy.readPaths])].map(literal),
      allowWrite: policy.writePaths.map(literal), denyWrite: [...policy.denyPaths, ...dependencies, "/tmp/claude", "/private/tmp/claude"].map(literal), allowGitConfig: false },
    enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false, allowAppleEvents: false, allowPty: false,
    ripgrep: { command: installation.ripgrep ?? "/usr/bin/rg" }, ...(installation.socat ? { socatPath: installation.socat } : {}),
  };
}
