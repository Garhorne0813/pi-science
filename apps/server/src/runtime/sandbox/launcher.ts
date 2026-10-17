/** Trusted watchdog. This file and its manifest are never writable by sandbox code. */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const [manifestPath, ...shellArgs] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath!, "utf8")) as { cli: string; settings: string; argv: string[]; env: Record<string, string>; timeoutSeconds: number; kernelBridge?: string; supervisor?: string; lifecycleTag?: string; deniedLifecycleTag?: string };
if (process.platform === "darwin" && !manifest.supervisor) throw new Error("macOS sandbox requires the native descendant supervisor");
const owner = process.ppid;
const kill = () => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } };
process.once("disconnect", kill);
const ownerTimer = setInterval(() => { if (process.ppid !== owner || process.ppid === 1) kill(); }, 250);
const deadline = setTimeout(kill, (manifest.timeoutSeconds + 1) * 1000);
const envArgs = Object.entries(manifest.env).map(([key, value]) => `${key}=${value}`);
const { startSandboxNetwork } = await import(new URL(import.meta.url.endsWith(".ts") ? "./network.ts" : "./network.js", import.meta.url).href);
const configured = JSON.parse(readFileSync(manifest.settings, "utf8"));
const network = await startSandboxNetwork(configured.network.allowedDomains.length
  ? { mode: "allowlist", allowedDomains: configured.network.allowedDomains, deniedDomains: configured.network.deniedDomains }
  : { mode: "none" });
configured.network.httpProxyPort = network.httpPort;
configured.network.socksProxyPort = network.socksPort;
writeFileSync(manifest.settings, JSON.stringify(configured), { mode: 0o600 });
// Keep only SRT's proxy endpoints when rebuilding the workload environment.
// Expansions are fixed shell code; all workload arguments remain positional.
const runtimeArgs = [manifest.cli, "--settings", manifest.settings, "--", "/bin/sh", "-c",
  'exec /usr/bin/env -i HTTP_PROXY="$HTTP_PROXY" HTTPS_PROXY="$HTTPS_PROXY" ALL_PROXY="$ALL_PROXY" http_proxy="$http_proxy" https_proxy="$https_proxy" all_proxy="$all_proxy" NO_PROXY="$NO_PROXY" no_proxy="$no_proxy" "$@"',
  "sandbox-env", ...envArgs, ...manifest.argv, ...shellArgs];
const child = spawn(manifest.supervisor ?? process.execPath, manifest.supervisor ? [String(manifest.timeoutSeconds + 1), manifest.lifecycleTag!, manifest.deniedLifecycleTag!, process.execPath, ...runtimeArgs] : runtimeArgs,
  { shell: false, stdio: ["inherit", "inherit", "inherit"], env: process.env, ...(manifest.supervisor ? { detached: true } : {}) });
// Signal the real bridge, not the CLI (whose startup interrupt terminates srt).
const interrupt = (pid: number) => {
  try {
    if (process.platform === "darwin") {
      // NOTE_TRACK owns cleanup; ps is used only to target a cooperative
      // bridge interrupt without interrupting the proxy/CLI which owns it.
      const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 2_000, maxBuffer: 4 * 1024 * 1024 })
        .split("\n").flatMap((line) => { const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : []; });
      const descendants = new Set([pid]);
      for (let changed = true; changed;) { changed = false; for (const item of processes) if (descendants.has(item.parent) && !descendants.has(item.pid)) { descendants.add(item.pid); changed = true; } }
      for (const item of processes) if (descendants.has(item.pid) && manifest.kernelBridge && item.command.includes(` -I -B ${manifest.kernelBridge}`)) process.kill(item.pid, "SIGINT");
      return;
    }
    // /proc/.../children is absent on some Linux runtimes; stat's PPid is portable.
    const children = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number).filter((candidate) => {
      try { const stat = readFileSync(`/proc/${candidate}/stat`, "utf8"); return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid; } catch { return false; }
    });
    for (const descendant of children) {
      const argv = readFileSync(`/proc/${descendant}/cmdline`, "utf8").split("\0");
      if (manifest.kernelBridge && argv[1] === "-I" && argv[2] === "-B" && argv[3] === manifest.kernelBridge) process.kill(descendant, "SIGINT");
      else interrupt(descendant);
    }
  } catch { /* exited while walking */ }
};
process.on("message", (message) => { if (message === "interrupt" && child.pid) interrupt(child.pid); });
child.once("error", kill);
child.once("close", (code) => { clearInterval(ownerTimer); clearTimeout(deadline); void network.close().finally(() => process.exit(code ?? 1)); });
