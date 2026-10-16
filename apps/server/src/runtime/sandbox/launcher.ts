/** Trusted Linux watchdog. This file and its manifest are never writable by sandbox code. */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
const [manifestPath, ...shellArgs] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath!, "utf8")) as { cli: string; settings: string; argv: string[]; env: Record<string, string>; timeoutSeconds: number; kernelBridge?: string };
const owner = process.ppid;
const kill = () => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } };
process.once("disconnect", kill);
const ownerTimer = setInterval(() => { if (process.ppid !== owner || process.ppid === 1) kill(); }, 250);
const deadline = setTimeout(kill, (manifest.timeoutSeconds + 1) * 1000);
const envArgs = Object.entries(manifest.env).map(([key, value]) => `${key}=${value}`);
const child = spawn(process.execPath, [manifest.cli, "--settings", manifest.settings, "--", "/usr/bin/env", "-i", ...envArgs, ...manifest.argv, ...shellArgs], { shell: false, stdio: ["inherit", "inherit", "inherit"], env: process.env });
// Signal the real bridge, not the CLI (whose startup interrupt terminates srt).
const interrupt = (pid: number) => {
  try {
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
child.once("close", (code) => { clearInterval(ownerTimer); clearTimeout(deadline); process.exit(code ?? 1); });
