import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { persistArtifactBytes } from "../artifacts/artifact-content-store.js";
import { snapshotWorkspace } from "../artifacts/workspace-artifact-snapshot.js";
import { canonicalDirectory, isWithin, type SandboxPolicy } from "./policy.js";

/** Candidate snapshots start at work, never at the research/evaluator root. */
export async function snapshotSandboxOutputs(cwd: string, policy: SandboxPolicy) {
  const snapshots = await Promise.all(policy.writePaths.map(async (root) => {
    const entries = await snapshotWorkspace(root);
    return entries?.filter((entry) => !policy.denyPaths.some((deny) => isWithin(deny, resolve(root, entry.path))))
      .map((entry) => ({ ...entry, path: relative(cwd, resolve(root, entry.path)).replaceAll("\\", "/") })) ?? null;
  }));
  return snapshots.some((entries) => entries === null) ? null : snapshots.flatMap((entries) => entries!);
}

/** Bound every component to an open directory and refuse links. An idle kernel
 * cannot redirect a host artifact read by renaming a directory or swapping a link. */
export async function readSandboxFile(policy: SandboxPolicy, target: string, maxBytes = 8 * 1024 * 1024, writeOnly = false): Promise<Buffer> {
  const root = (writeOnly ? policy.writePaths : policy.readPaths).find((path) => isWithin(path, target));
  if (!root || policy.denyPaths.some((deny) => isWithin(deny, target))) throw new Error("File is outside authorized sandbox paths");
  await canonicalDirectory(root);
  let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const components = relative(root, target).split(sep);
    if (components.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid sandbox file path");
    const filename = components.pop()!;
    for (const component of components) {
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    const file = await open(`/proc/self/fd/${directory.fd}/${filename}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error("Sandbox file requires a bounded single-link regular file");
      const bytes = Buffer.alloc(info.size); let offset = 0;
      while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      const after = await file.stat();
      if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error("Sandbox file changed during capture");
      return bytes;
    } finally { await file.close(); }
  } finally { await directory.close(); }
}
export function sandboxArtifactCapture(cwd: string, policy: SandboxPolicy) {
  let files = 0; let remaining = 8 * 1024 * 1024;
  return async (target: string): Promise<{ sha256: string; size: number }> => {
    if (++files > 16) throw new Error("Sandbox artifact file limit exceeded");
    const bytes = await readSandboxFile(policy, target, remaining, true);
    remaining -= bytes.length;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await persistArtifactBytes(cwd, sha256, bytes);
    return { sha256, size: bytes.length };
  };
}
