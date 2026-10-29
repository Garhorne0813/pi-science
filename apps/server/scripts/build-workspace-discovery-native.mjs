import { access, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export async function buildWorkspaceDiscoveryNative({
  platform = process.platform,
  root = fileURLToPath(new URL("../", import.meta.url)),
  nodeExecutable = process.execPath,
  headersDirectory = process.env.PI_SCIENCE_NODE_HEADERS,
  compile = spawnSync,
  warn = console.warn,
  required = false,
} = {}) {
  if (platform !== "darwin") return;
  const output = join(root, "dist/native/workspace-discovery-darwin.node");
  const temporary = `${output}.${process.pid}`;
  try {
    const candidates = [headersDirectory, resolve(dirname(await realpath(nodeExecutable)), "../include/node")].filter(Boolean);
    let headers;
    for (const candidate of candidates) {
      try { await access(join(candidate, "node_api.h")); headers = candidate; break; } catch { /* try next local installation */ }
    }
    if (!headers) throw new Error("macOS discovery build needs local Node.js headers (node_api.h). Install Node with headers or set PI_SCIENCE_NODE_HEADERS to its include/node directory.");
    await mkdir(dirname(output), { recursive: true });
    const result = compile("xcrun", ["clang", "-arch", process.arch === "arm64" ? "arm64" : "x86_64", "-std=c11", "-Wall", "-Wextra", "-Werror", "-DNAPI_VERSION=8", "-bundle", "-undefined", "dynamic_lookup", "-I", headers,
      join(root, "native/workspace-discovery-darwin.c"), "-o", temporary], { stdio: "inherit", timeout: 60000 });
    if (result.error || result.status !== 0) throw new Error("macOS discovery build failed. Install Xcode Command Line Tools with xcode-select --install.", { cause: result.error });
    await rename(temporary, output);
  } catch (error) {
    // Never retain an older backend after a failed rebuild.
    await rm(output, { force: true });
    if (required) throw error;
    warn(`[workspace-discovery] ${error.message} Native ls/glob/grep are unavailable (tool_unavailable); continuing without macOS discovery.`);
  } finally { await rm(temporary, { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWorkspaceDiscoveryNative({ required: process.argv.includes("--required") });
}
