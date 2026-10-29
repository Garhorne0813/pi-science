import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, readdir, realpath } from "node:fs/promises";
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

const runFile = promisify(execFile);
const sharedLibraryCache = new Map<string, { stamp: string; roots: string[] }>();
const systemLibraryRoots = ["/usr/lib", "/System", "/Library/Apple"];
const LOAD_CLOSURE_DEPTH = 8;
/** The library file itself and the file its symlinks resolve to. Ancestor
 * directories are deliberately absent: every allow entry compiles to a subpath
 * grant, so granting `opt` or the Homebrew prefix would expose every config
 * file beneath it. Traversal needs metadata only, which the profile builder
 * adds for the directories and links an allowed path runs through. */
async function libraryGrants(path: string): Promise<string[]> {
  const grants = [path];
  const target = await realpath(path).catch(() => undefined);
  if (target && target !== path) grants.push(target);
  return grants;
}
/** Configuration a keg's runtime opens at startup. OpenSSL refuses to start node
 * without the `openssl.cnf` that `/prefix/Cellar/<formula>/<version>` does not
 * ship, so the files at the top of `/prefix/etc/<formula>` are granted — the
 * files only, never the directory and never the prefix `etc` tree. */
async function kegConfigGrants(library: string): Promise<string[]> {
  const parts = library.split("/").filter(Boolean);
  const keg = parts.indexOf("Cellar");
  if (keg < 1 || parts.length < keg + 3) return [];
  const config = `/${[...parts.slice(0, keg), "etc", parts[keg + 1]!].join("/")}`;
  return (await readdir(config, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => join(config, entry.name));
}
/** Candidate files for a dyld entry that is not an absolute path. `@rpath` and
 * `@loader_path` spellings resolve next to the loading library or one `lib`
 * above it, so both candidates stay inside a keg this walk already visits. */
const dyldCandidates = (entry: string, loader: string): string[] => {
  const name = entry.startsWith("@rpath/") ? entry.slice("@rpath/".length) : entry.startsWith("@loader_path/") ? entry.slice("@loader_path/".length) : undefined;
  return name === undefined ? [] : [join(dirname(loader), name), join(dirname(loader), "..", "lib", name)];
};
/** Everything one library contributes: the file spellings the loader writes and
 * the startup configuration of its keg. Keg grants need the resolved path,
 * because the spelling runs through `opt/<formula>` and never names `Cellar`. */
async function collectReads(spelling: string, resolved: string | undefined, roots: Set<string>): Promise<void> {
  for (const grant of await libraryGrants(spelling)) roots.add(grant);
  for (const grant of await kegConfigGrants(resolved ?? spelling)) roots.add(grant);
}
/** Every non-system library `binary` loads, followed through the libraries those
 * libraries link. One `otool -L` level is not the closure: a Homebrew formula
 * links further formulae, and dyld aborts on the first library no grant covers. */
async function collectLibraryReads(binary: string, roots: Set<string>, visited: Set<string>, depth = 0): Promise<void> {
  if (depth > LOAD_CLOSURE_DEPTH) return;
  const { stdout } = await runFile("/usr/bin/otool", ["-L", binary], { timeout: 5_000, maxBuffer: 256 * 1024 });
  for (const line of stdout.split("\n").slice(1)) {
    const entry = line.trim().split(" ")[0];
    if (!entry) continue;
    for (const candidate of entry.startsWith("/") ? [entry] : dyldCandidates(entry, binary)) {
      if (systemLibraryRoots.some((root) => isWithin(root, candidate))) continue;
      const resolved = await realpath(candidate).catch(() => undefined);
      await collectReads(candidate, resolved, roots);
      if (!resolved || visited.has(resolved)) continue;
      visited.add(resolved);
      await collectLibraryReads(resolved, roots, visited, depth + 1).catch(() => undefined);
    }
  }
}
/** Shared libraries a dynamically linked executable loads at launch. Cached on
 * the binary identity so repeated sandbox preparation does not respawn otool. */
export async function executableReadRoots(executable: string): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const canonical = await realpath(executable);
  const info = await lstat(canonical);
  if (!info.isFile()) return [];
  const stamp = `${info.mtimeMs}:${info.size}`;
  const cached = sharedLibraryCache.get(canonical);
  if (cached?.stamp === stamp) return cached.roots;
  const roots = new Set<string>();
  try { await collectReads(canonical, canonical, roots); await collectLibraryReads(canonical, roots, new Set([canonical])); } catch { /* otool unavailable: fall back below */ }
  if (!roots.size) {
    // An installation whose libraries otool cannot list keeps a grant on its own
    // lib prefix. That directory is still one installation, never a shared parent.
    try { const prefixLib = await realpath(join(dirname(canonical), "..", "lib")); if ((await lstat(prefixLib)).isDirectory()) roots.add(prefixLib); }
    catch { /* installations without a prefix lib keep the binary grant */ }
  }
  const resolved = [...roots].sort();
  sharedLibraryCache.set(canonical, { stamp, roots: resolved });
  return resolved;
}

export async function runtimeDependencyGrants(policy: RuntimeReadPolicy, dependencies: string[]): Promise<string[]> {
  const direct = await Promise.all(dependencies.map(canonicalRuntimeDependency));
  const roots = new Set(direct);
  // A dynamically linked runtime needs its shared libraries, not only the entry
  // binary. Homebrew Node keeps libnode and friends outside the executable dir,
  // so granting `node` alone leaves dyld rejected inside the sandbox.
  for (const dependency of direct) for (const extra of await executableReadRoots(dependency)) roots.add(extra);
  for (const path of roots) {
    if (policy.protectedRoots.some((protectedPath) => pathsOverlap(path, protectedPath))) throw new Error("Protected paths overlap sandbox runtime read grants");
    if (policy.dependencyRoots && ![...policy.systemReads, ...policy.dependencyRoots].some((root) => isWithin(root, path))) throw new Error("Runtime dependency is outside the shared operator read policy");
  }
  return [...roots];
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
