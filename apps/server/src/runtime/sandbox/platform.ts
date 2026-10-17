import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

export function requireSandboxPlatform(): void {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Sandbox execution is disabled on this platform");
  if (!["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported sandbox architecture");
}

/** Compile trusted source into the private, non-workload-writable control dir.
 * Missing developer tools fail closed. Production builds may ship this helper. */
export async function prepareMacosSupervisor(control: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  await access("/usr/bin/sandbox-exec", constants.X_OK);
  const source = fileURLToPath(new URL("./macos-supervisor.c", import.meta.url));
  const output = join(control, "supervisor");
  await promisify(execFile)("/usr/bin/clang", ["-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output], {
    timeout: 30_000, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin", HOME: control, TMPDIR: control },
  });
  return output;
}
