import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { DiscoveryError } from "./workspace-discovery-contract.js";
import { darwinDirectory } from "./workspace-discovery-native.js";

interface PinnedDirectory {
  names(maximum: number): AsyncIterable<string>;
  stat(name: string): Promise<{ directory: boolean; file: boolean; nlink: number }>;
}

/** Pin directories before enumeration. macOS refuses every symlink at open
 * using O_NOFOLLOW_ANY, then fdopendir/fstatat never resolve the pathname again. */
export async function directory<T>(path: string, consume: (pinned: PinnedDirectory) => Promise<T>): Promise<T> {
  const handles: FileHandle[] = [];
  try {
    let handle: FileHandle;
    let pinned: PinnedDirectory;
    if (process.platform === "linux") {
      handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY); handles.push(handle);
      for (const part of path.split("/").filter(Boolean)) {
        handle = await open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(handle);
      }
      const prefix = `/proc/self/fd/${handle.fd}`;
      pinned = {
        async *names() { for await (const entry of await opendir(prefix)) yield entry.name; },
        async stat(name) { const info = await lstat(`${prefix}/${name}`); return { directory: info.isDirectory(), file: info.isFile(), nlink: info.nlink }; },
      };
    } else if (process.platform === "darwin" && darwinDirectory) {
      handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000); handles.push(handle);
      const fd = handle.fd;
      const native = darwinDirectory;
      pinned = {
        async *names(maximum) { yield* native.names(fd, maximum); },
        async stat(name) { return native.stat(fd, name); },
      };
    } else throw new DiscoveryError("tool_unavailable");
    const result = await consume(pinned);
    const entry = await lstat(path, { bigint: true }); const captured = await handle.stat({ bigint: true });
    if (entry.dev !== captured.dev || entry.ino !== captured.ino) throw new DiscoveryError("access_denied");
    return result;
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}
