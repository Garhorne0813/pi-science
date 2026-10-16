import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { canonicalDirectory } from "./policy.js";

/** Linux descriptor walk pins every directory and refuses symlinks in all components.
 * Native fallback validates the path entry against the opened descriptor.
 * Every platform consumes only bounded, single-link regular-file descriptors. */
async function withRegularFile<T>(path: string, maximum: number, consume: (handle: FileHandle, size: number) => Promise<T>): Promise<T> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("File reads require canonical absolute paths");
  const parts = relative(parse(path).root, path).split("/");
  const handles: FileHandle[] = [];
  try {
    let target = path;
    if (process.platform === "linux") {
      let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY); handles.push(parent);
      for (const part of parts.slice(0, -1)) { parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(parent); }
      target = `/proc/self/fd/${parent.fd}/${parts.at(-1)}`;
    } else await canonicalDirectory(dirname(path));
    const entry = process.platform === "linux" ? undefined : await lstat(path, { bigint: true });
    if (entry && (!entry.isFile() || entry.nlink !== 1n || entry.size > BigInt(maximum))) throw new Error("Read requires a bounded single-link regular file");
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)); handles.push(handle);
    const before = await handle.stat({ bigint: true });
    if (entry && (entry.dev !== before.dev || entry.ino !== before.ino)) throw new Error("File changed before capture");
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) throw new Error("Read requires a bounded single-link regular file");
    const result = await consume(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("File changed during capture");
    return result;
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

export async function readRegularFile(path: string, maximum: number): Promise<Buffer> {
  return withRegularFile(path, maximum, async (handle, size) => {
    const buffer = Buffer.alloc(size + 1); let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== size) throw new Error("File changed during capture");
    return buffer.subarray(0, length);
  });
}
