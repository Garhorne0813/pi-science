import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWithin, type SandboxPolicy } from "./policy.js";
import { pathsOverlap, runtimeDependencyGrants, runtimeReadPolicy, runtimeReadPolicyId, sandboxRuntimeRoot } from "./read-grants.js";
import { profileConfiguration } from "./profiles.js";
import { requireSandboxPlatform } from "./platform.js";
export { srtCli } from "./read-grants.js";

export const SANDBOX_RUNTIME = "@anthropic-ai/sandbox-runtime@0.0.79";
export interface RuntimeInstallation { socat?: string; ripgrep?: string }
export function runtimeInstallation(): RuntimeInstallation {
  return { socat: process.env.PI_SCIENCE_SANDBOX_SOCAT, ripgrep: process.env.PI_SCIENCE_SANDBOX_RIPGREP };
}
export function bashDependencies(): string[] {
  const paths: unknown = JSON.parse(process.env.PI_SCIENCE_SANDBOX_RUNTIME_PATHS ?? "[]");
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) throw new Error("Invalid operator sandbox runtime paths");
  return [...new Set([...(paths as string[]), ...(process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT ? [process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT] : [])])];
}
/** Exact-version platform configuration shared by one-shot and persistent processes. */
export async function processSettings(policy: SandboxPolicy, dependencies: string[], installation = runtimeInstallation()) {
  requireSandboxPlatform();
  if (policy.scope === "candidate" && (policy.network.mode !== "none" || policy.profile && policy.profile !== "candidate")) throw new Error("Candidate sandbox cannot inherit a broader execution profile");
  if (policy.profilePolicyId && policy.profilePolicyId !== (await profileConfiguration()).id) throw new Error("Sandbox profile configuration changed after admission");
  const root = sandboxRuntimeRoot;
  // Workloads must not rewrite the launcher/service code or its runtime and gain
  // host execution on a later call. A checkout used as the server installation
  // cannot simultaneously be its untrusted writable workspace.
  const serverRoot = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
  for (const trusted of [serverRoot, root, process.execPath]) if (policy.writePaths.some((write) => isWithin(write, trusted) || isWithin(trusted, write))) throw new Error("Writable sandbox paths overlap the trusted server installation");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.version !== "0.0.79") throw new Error("Sandbox runtime version has not been validated");
  if (!["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported sandbox architecture");
  if (process.platform === "linux") await access(join(root, "vendor/seccomp", process.arch, "apply-seccomp"), constants.X_OK);
  else await access("/usr/bin/sandbox-exec", constants.X_OK);
  const readPolicy = await runtimeReadPolicy();
  if (policy.operatorReadPolicyId && policy.operatorReadPolicyId !== runtimeReadPolicyId(readPolicy)) throw new Error("Operator read policy changed before sandbox startup");
  if (readPolicy.file && policy.writePaths.some((write) => pathsOverlap(write, readPolicy.file!))) throw new Error("Operator read policy must be outside writable sandbox paths");
  const dependencyReads = await runtimeDependencyGrants(readPolicy, dependencies);
  const reads = [...readPolicy.systemReads, ...dependencyReads];
  for (const path of [...reads, ...policy.readPaths, ...policy.writePaths]) {
    if (readPolicy.protectedRoots.some((protectedPath) => pathsOverlap(path, protectedPath))) throw new Error("Protected paths overlap sandbox runtime read grants");
  }
  for (const canonical of dependencyReads) {
    if (policy.writePaths.some((write) => pathsOverlap(write, canonical))) throw new Error("Runtime dependencies must be outside writable sandbox paths");
  }
  for (const binary of [installation.socat, installation.ripgrep]) if (binary) {
    if (!isAbsolute(binary)) throw new Error("Sandbox helper paths must be absolute");
    if (readPolicy.protectedRoots.some((protectedPath) => pathsOverlap(binary, protectedPath))) throw new Error("Protected paths overlap sandbox runtime read grants");
    const canonical = await realpath(binary);
    if (policy.writePaths.some((write) => isWithin(write, canonical))) throw new Error("Sandbox helpers must be outside writable sandbox paths");
    await runtimeDependencyGrants(readPolicy, [canonical]);
    await access(canonical, constants.X_OK);
  }
  const literal = (path: string) => ({ path, literal: true as const });
  const credentialNames = [".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".modal.toml", "credentials.json", "credentials.toml", ".env", ".env.*"];
  const credentials = [...new Set([...policy.readPaths, ...policy.writePaths])].flatMap((root) => credentialNames.map((name) => join(root, "**", name)));
  return {
    network: { allowedDomains: policy.network.mode === "allowlist" ? policy.network.allowedDomains : [], deniedDomains: policy.network.mode === "allowlist" ? policy.network.deniedDomains : ["*"], strictAllowlist: true,
      allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
    filesystem: { denyRead: [...["/", ...readPolicy.protectedRoots, ...policy.denyPaths].map(literal), ...credentials], allowRead: [...new Set([...reads, join(root, "vendor/seccomp"), ...(installation.socat ? [installation.socat] : []), ...policy.readPaths])].map(literal),
      allowWrite: policy.writePaths.map(literal), denyWrite: [...[...readPolicy.protectedRoots, ...policy.denyPaths, ...dependencies, "/tmp/claude", "/private/tmp/claude"].map(literal), ...credentials], allowGitConfig: false },
    enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false, allowAppleEvents: false, allowPty: false,
    ripgrep: { command: installation.ripgrep ?? "/usr/bin/rg" }, ...(installation.socat ? { socatPath: installation.socat } : {}),
  };
}
