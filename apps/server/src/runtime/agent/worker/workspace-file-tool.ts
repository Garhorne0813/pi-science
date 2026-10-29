import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { configRoot } from "../../../storage/persistence.js";
import { workspacePolicy } from "../../sandbox/policy.js";
import { sessionMode } from "../../sandbox/session-approval.js";
import { executionGrantsDirectory } from "../../sandbox/execution-grants.js";
import { networkGrantsPath } from "../../sandbox/network-grants.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { ok, type AgentHarnessTool, type NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { canonicalDirectory, isSensitiveWorkspaceName, isWithin } from "../../sandbox/policy.js";
import { runtimeReadPolicy, pathsOverlap } from "../../sandbox/read-grants.js";
import { readRegularFile } from "../../sandbox/file-read.js";
import { writeSandboxFile } from "../../sandbox/file-write.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;
/** Tools may manage research protocol/candidate files, but never service-private
 * state, protected assets or aliases escaping the workspace. Skill roots are read-only. */
export function workspaceFileTool(original: Tool, cwd: string, skillRoots: string[], sessionId?: string): Tool {
  return { ...original, async execute(id, params, update, ctx, invocation, context) {
    const full = await sessionMode(cwd, sessionId) === "full";
    const home = full ? await realpath(homedir()) : cwd;
    const protectedRoots = (await runtimeReadPolicy()).protectedRoots;
    const executionGrantsRoot = await executionGrantsDirectory();
    const check = (path: string, write = false) => {
      path = resolve(cwd, path);
      if (isWithin(configRoot(), path)) throw new Error("Application state is service-owned");
      if (isWithin(executionGrantsRoot, path)) throw new Error("Execution grants are service-owned");
      if (isWithin(dirname(networkGrantsPath()), path)) throw new Error("Network permissions are service-owned");
      if (write && pathsOverlap(fileURLToPath(new URL("../../../../", import.meta.url)), path)) throw new Error("Trusted server installation is not writable by file tools");
      if (protectedRoots.some((root) => pathsOverlap(root, path))) throw new Error("Protected service data is unavailable to file tools");
      if (write && skillRoots.some((root) => pathsOverlap(root, path))) throw new Error("Skill resources are read-only");
      const readRoot = !write ? skillRoots.find((root) => isWithin(root, path)) : undefined;
      const root = readRoot ?? (full && isWithin(home, path) ? home : cwd);
      if (!isWithin(root, path) || relative(root, path).split(/[\\/]/).some(isSensitiveWorkspaceName)) throw new Error("File access is outside authorized workspace data");
      return path;
    };
    check(String((params as { path?: string }).path ?? ""), original.name !== "read");
    const env = new Proxy(ctx.env, { get(target, property) {
      if (["readBinaryFile", "readTextFile"].includes(String(property))) return async (requested: string) => {
        const path = check(requested);
        const bytes = await readRegularFile(path, 16 * 1024 * 1024);
        return ok(property === "readTextFile" ? bytes.toString("utf8") : bytes);
      };
      if (property === "writeFile") return async (requested: string, bytes: string | Uint8Array) => {
        const path = check(requested, true);
        const writeRoot = full && isWithin(home, path) ? home : cwd;
        const canonicalRoot = await canonicalDirectory(writeRoot);
        const destination = resolve(canonicalRoot, relative(writeRoot, path));
        if (process.platform === "darwin") {
          try { const info = await lstat(destination); if (!info.isFile() || info.nlink !== 1) throw new Error("Writes require a single-link regular workspace file"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          await writeSandboxFile(canonicalRoot, destination, bytes, context.abortSignal, full ? await workspacePolicy(cwd, undefined, "analysis", sessionId) : undefined); return ok(undefined);
        }
        const parts = relative(writeRoot, path).split(/[\\/]/); const handles: FileHandle[] = [];
        let temporary: string | undefined;
        try {
          let parentPath = writeRoot;
          let parent: FileHandle | undefined;
          if (process.platform === "linux") { parent = await open(writeRoot, constants.O_RDONLY | constants.O_DIRECTORY); handles.push(parent); parentPath = `/proc/self/fd/${parent.fd}`; }
          for (const part of parts.slice(0, -1)) {
            const child = resolve(parentPath, part); await mkdir(child).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
            if (process.platform === "linux") { parent = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parent); parentPath = `/proc/self/fd/${parent.fd}`; }
            else { await canonicalDirectory(child); check(child, true); parentPath = child; }
          }
          const destination = resolve(parentPath, parts.at(-1)!);
          const validateDestination = async () => {
            try { const info = await lstat(destination); if (!info.isFile() || info.nlink !== 1) throw new Error("Writes require a single-link regular workspace file"); return info; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          };
          const previous = await validateDestination();
          const pending = resolve(parentPath, `.pi-write-${randomUUID()}.tmp`);
          const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); temporary = pending;
          try { context.abortSignal?.throwIfAborted(); await file.writeFile(bytes); if (previous) await file.chmod(previous.mode & 0o777); await file.sync(); }
          finally { await file.close(); }
          context.abortSignal?.throwIfAborted(); await validateDestination();
          // Same-directory rename commits either the previous complete bytes or
          // the new complete bytes. Never truncate a checkpoint in place.
          await rename(temporary, destination); temporary = undefined;
          if (parent) await parent.sync();
          return ok(undefined);
        } finally {
          try { if (temporary) await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
          finally { for (const handle of handles.reverse()) await handle.close(); }
        }
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    return original.execute(id, params, update, { ...ctx, env }, invocation, context);
  } };
}
