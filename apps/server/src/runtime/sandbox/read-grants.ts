import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { homedir } from "node:os";
import { canonicalDirectory, identifyPolicy, isWithin, type SandboxPolicy } from "./policy.js";

export const srtCli = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime")).replace(/index\.js$/, "cli.js");
export const sandboxRuntimeRoot = dirname(dirname(srtCli));
const systemPaths = ["/usr/bin", "/usr/lib", "/usr/lib64", "/bin", "/lib", "/lib64", "/etc/ld.so.cache", "/dev/null", "/dev/urandom", "/dev/random"];
export const pathsOverlap = (left: string, right: string) => isWithin(left, right) || isWithin(right, left);
const schema = z.object({ schemaVersion: z.literal(1), dependencyRoots: z.array(z.string().min(1).max(4096)).max(1024), protectedRoots: z.array(z.string().min(1).max(4096)).min(1).max(1024) }).strict();
export interface RuntimeReadPolicy { systemReads: string[]; dependencyRoots?: string[]; protectedRoots: string[]; file?: string }
export const runtimeReadPolicyId = (policy: RuntimeReadPolicy) => createHash("sha256").update(JSON.stringify(policy)).digest("hex");

export async function canonicalRuntimeDependency(path: string): Promise<string> {
  const broad = [homedir(), "/", "/home", "/Users", "/opt", "/usr", "/usr/local", "/tmp", "/private/tmp", "/var", "/private"];
  if (!isAbsolute(path) || broad.includes(path)) throw new Error("Dependencies require explicit narrow absolute paths");
  const canonical = await realpath(path);
  if (broad.includes(canonical)) throw new Error("Dependencies require explicit narrow absolute paths");
  return canonical;
}

/** Optional operator-owned dependency/protected-root policy shared by ordinary runtimes. */
export async function runtimeReadPolicy(): Promise<RuntimeReadPolicy> {
  const systemReads: string[] = [];
  const platformPaths = process.platform === "darwin" ? ["/System/Library", "/usr/lib", "/usr/share/locale", "/private/etc/ssl", "/private/var/select", "/Library/Apple/System/Library"] : [];
  for (const path of [...systemPaths, ...platformPaths, join(sandboxRuntimeRoot, "vendor/seccomp")]) {
    try { systemReads.push(await realpath(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const file = process.env.PI_SCIENCE_SANDBOX_READ_POLICY;
  if (file === undefined) return { systemReads: [...new Set(systemReads)], protectedRoots: [] };
  if (!isAbsolute(file) || resolve(file) !== file) throw new Error("Operator read policy requires a canonical absolute path");
  await canonicalDirectory(dirname(file));
  for (let directory = dirname(file); dirname(directory) !== directory; directory = dirname(directory)) {
    const info = await lstat(directory);
    if ((info.mode & 0o022) && !(info.mode & 0o1000)) throw new Error("Operator read policy has a writable ancestor");
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 64n * 1024n || (before.mode & 0o077n) || before.uid !== BigInt(process.getuid!())) throw new Error("Operator read policy must be a private single-link regular file");
    const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (length !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw new Error("Operator read policy changed during read");
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
  const parsed = schema.parse(JSON.parse(text));
  const dependencyRoots = await Promise.all(parsed.dependencyRoots.map(canonicalRuntimeDependency));
  const protectedRoots = [file, ...await Promise.all(parsed.protectedRoots.map(canonicalDirectory))];
  if (protectedRoots.some((protectedPath) => [...systemReads, ...dependencyRoots].some((read) => pathsOverlap(protectedPath, read)))) throw new Error("Protected paths overlap sandbox runtime read grants");
  return { systemReads: [...new Set(systemReads)], dependencyRoots, protectedRoots: [...new Set(protectedRoots)], file };
}

export async function runtimeDependencyGrants(policy: RuntimeReadPolicy, dependencies: string[]): Promise<string[]> {
  const roots = await Promise.all(dependencies.map(canonicalRuntimeDependency));
  for (const path of roots) {
    if (policy.protectedRoots.some((protectedPath) => pathsOverlap(path, protectedPath))) throw new Error("Protected paths overlap sandbox runtime read grants");
    if (policy.dependencyRoots && ![...policy.systemReads, ...policy.dependencyRoots].some((root) => isWithin(root, path))) throw new Error("Runtime dependency is outside the shared operator read policy");
  }
  return [...new Set(roots)];
}

/** Bind the effective operator policy before recording/using a kernel policy.
 * Reusing an already-bound admission after a config change must fail closed. */
export async function bindRuntimeReadPolicy(policy: SandboxPolicy): Promise<SandboxPolicy> {
  if (policy.mode !== "required") return policy;
  if (process.env.PI_SCIENCE_SANDBOX_READ_POLICY === undefined && !policy.operatorReadPolicyId) return policy;
  const id = runtimeReadPolicyId(await runtimeReadPolicy());
  if (policy.operatorReadPolicyId && policy.operatorReadPolicyId !== id) throw new Error("Operator read policy changed after admission");
  return identifyPolicy({ ...policy, operatorReadPolicyId: id });
}
