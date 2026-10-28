import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

interface NativeDirectory {
  names(fd: number, maximum: number): string[];
  stat(fd: number, name: string): { directory: boolean; file: boolean; nlink: number };
}

// src/ and dist/ have the same depth. The build produces a local Node-API
// binary; neither startup nor a tool call compiles code or downloads headers.
export const darwinDirectory: NativeDirectory | undefined = (() => {
  if (process.platform !== "darwin") return undefined;
  try {
    const native: NativeDirectory = createRequire(import.meta.url)(fileURLToPath(new URL("../../../../dist/native/workspace-discovery-darwin.node", import.meta.url)));
    return typeof native.names === "function" && typeof native.stat === "function" ? native : undefined;
  } catch { return undefined; }
})();
