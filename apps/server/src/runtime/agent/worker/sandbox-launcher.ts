/** Trusted watchdog. The IPC channel closes when the owning Worker dies. Never imports project code. */
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
const [cli, settings, python, script, seconds] = process.argv.slice(2);
if (!process.send || !cli || !settings || !python || !script || !seconds) process.exit(1);
const killGroup = () => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } };
process.once("disconnect", killGroup);
// A second deadline survives the owning Worker's crash or stalled event loop.
const timer = setTimeout(killGroup, (Number(seconds) + 1) * 1000);
const child = spawn(process.execPath, [cli, "--settings", settings, "--", "/usr/bin/env", `HOME=${join(dirname(script), ".runtime")}`, `TMPDIR=${join(dirname(script), ".runtime")}`, `TMP=${join(dirname(script), ".runtime")}`, `TEMP=${join(dirname(script), ".runtime")}`, python, "-I", "-B", script], { shell: false, stdio: ["ignore", "inherit", "inherit"], env: process.env });
child.once("error", () => { clearTimeout(timer); killGroup(); });
child.once("close", (code) => { clearTimeout(timer); process.exitCode = code ?? 1; process.removeListener("disconnect", killGroup); process.disconnect(); });
