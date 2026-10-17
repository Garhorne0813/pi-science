import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { identifyPolicy, workspacePolicy, protectedPaths, isWithin } from "./policy.js";
import { prepareSandbox, launcherPath, killSandboxGroup } from "./process.js";

/** Darwin lacks Node's /proc/self/fd directory traversal. Perform the commit
 * inside an OS-confined helper so a parent swap cannot redirect a host write. */
export async function writeSandboxFile(cwd: string, target: string, bytes: string | Uint8Array, signal?: AbortSignal): Promise<void> {
  if (!isWithin(cwd, target)) throw new Error("Write escapes the workspace");
  if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error("File write exceeds 16 MiB");
  signal?.throwIfAborted();
  const base = await workspacePolicy(cwd);
  const policy = identifyPolicy({ ...base, mode: "required", readPaths: [cwd], writePaths: [cwd], denyPaths: base.mode === "required" ? base.denyPaths : await protectedPaths(cwd), network: { mode: "none" } });
  const helper = fileURLToPath(new URL("./file-write-helper.mjs", import.meta.url));
  const prepared = await prepareSandbox(policy, [process.execPath, helper, target], [process.execPath, helper], 30);
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [launcherPath, prepared.manifest], { cwd, env: prepared.env, detached: true, stdio: ["pipe", "ignore", "pipe", "ipc"] });
      const abort = () => killSandboxGroup(child.pid); let errorOutput = "";
      child.stderr!.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-4096); });
      child.stdin!.on("error", () => undefined); child.stdin!.end(bytes);
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      child.once("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
      child.once("close", (code) => { signal?.removeEventListener("abort", abort); if (signal?.aborted) reject(signal.reason); else if (code !== 0) reject(new Error(`Sandbox file write failed: ${errorOutput}`)); else resolve(); });
    });
  } finally { await prepared.cleanup(); }
}
