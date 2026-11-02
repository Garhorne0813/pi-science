#!/usr/bin/env node
// Dependency discovery and a bounded, offline Bubblewrap namespace probe.
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const tools = {
  rg: "PI_SCIENCE_SANDBOX_RIPGREP",
  socat: "PI_SCIENCE_SANDBOX_SOCAT",
  bwrap: "PI_SCIENCE_SANDBOX_BWRAP",
};
const installationHelp = "Install Linux sandbox dependencies:\n  Debian/Ubuntu: sudo apt-get install ripgrep socat bubblewrap\n  Fedora: sudo dnf install ripgrep socat bubblewrap\n  Arch: sudo pacman -S ripgrep socat bubblewrap";

export async function resolveSandboxTool(name, environment = process.env) {
  if (!Object.hasOwn(tools, name)) throw new Error(`Unknown sandbox helper: ${name}`);
  const variable = tools[name];
  const override = environment[variable];
  if (override !== undefined && !isAbsolute(override)) throw new Error(`${variable} must be an absolute executable path.`);
  const candidates = override !== undefined ? [override] : (environment.PATH ?? "").split(delimiter)
    .filter((directory) => isAbsolute(directory)).map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      if ((await stat(canonical)).isFile()) return canonical;
    } catch { /* An explicit invalid override must never fall back to PATH. */ }
  }
  throw new Error(`${override !== undefined ? `${variable}=${override} is not executable` : `Linux sandbox helper '${name}' was not found on PATH`}.\n${installationHelp}`);
}

function probeNamespaces(bwrap, command, label, run) {
  const result = run(bwrap, [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net",
    "--cap-drop", "ALL", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", ...command,
  ], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}, signal ${result.signal ?? "none"}`;
    throw new Error(`${label} startup check failed: ${detail}\nBubblewrap must be allowed to create user, mount, PID and network namespaces. Check your container/host namespace and AppArmor policies, including restrictions on Bubblewrap child processes. Pi-Science will not disable isolation automatically.`);
  }
}

export function probeLinuxSandbox(bwrap, run = spawnSync) {
  probeNamespaces(bwrap, ["/bin/true"], "Linux sandbox", run);
}

export async function checkLinuxSeccomp(environment = process.env, run = spawnSync) {
  const bwrap = await resolveSandboxTool("bwrap", environment);
  const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
  let helper;
  try {
    const runtimeRoot = resolve(dirname(require.resolve("@anthropic-ai/sandbox-runtime")), "..");
    helper = join(runtimeRoot, "vendor/seccomp", process.arch, "apply-seccomp");
    await access(helper, constants.X_OK);
  } catch {
    throw new Error("Linux nested seccomp helper is unavailable; reinstall the server dependencies for this architecture.");
  }
  probeNamespaces(bwrap, [helper, "/bin/true"], "Linux nested seccomp", run);
}

export async function checkLinuxSandbox(environment = process.env) {
  const installation = {};
  for (const name of Object.keys(tools)) installation[name] = await resolveSandboxTool(name, environment);
  probeLinuxSandbox(installation.bwrap);
  return installation;
}

async function main() {
  if (process.platform !== "linux") return;
  if (process.argv.length === 4 && process.argv[2] === "--tool") {
    console.log(await resolveSandboxTool(process.argv[3]));
  } else if (process.argv.length === 3 && process.argv[2] === "--probe") {
    probeLinuxSandbox(await resolveSandboxTool("bwrap"));
    console.log("  Linux sandbox: namespace startup check passed");
  } else throw new Error("Usage: node scripts/check-linux-sandbox.mjs --tool <rg|socat|bwrap> | --probe");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
