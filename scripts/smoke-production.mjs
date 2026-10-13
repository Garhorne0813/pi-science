#!/usr/bin/env node
// Real build + platform launcher acceptance. No provider credentials or Python/R.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
const root = fileURLToPath(new URL("../", import.meta.url));
const windows = process.platform === "win32";
const temporary = await mkdtemp(join(tmpdir(), "pi science production "));
async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
const port = await freePort();
const env = { ...process.env, PI_SCIENCE_MODE: "production", PI_SCIENCE_FRONTEND_DIST: "frontend/dist", PI_SCIENCE_HOME: join(temporary, "data"), PI_SCIENCE_WORKSPACES: join(temporary, "workspaces"), PI_SCIENCE_BIN_DIR: join(temporary, "bin"), PNPM_STORE_DIR: join(temporary, "store"), PI_SCIENCE_CONTROL_PLANE_PORT: String(port), PI_SCIENCE_OPEN_BROWSER: "0" };
const executable = windows ? "powershell.exe" : "bash";
const script = join(root, "scripts", windows ? "pi-science.ps1" : "pi-science.sh");
const prefix = windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : [script];
function command(args, expectedStatus = 0) {
  const result = spawnSync(executable, [...prefix, ...args], { cwd: temporary, env, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
  return result.stdout;
}
let launcher;
let listener;
let output = "";
const stateFile = join(root, ".runtime", "pi-science", "run.state");
try {
  // Missing production artifacts must fail without falling back to source mode.
  const fixture = join(temporary, "checkout with spaces");
  await mkdir(join(fixture, "scripts"), { recursive: true });
  for (const name of windows ? ["start.ps1", "process-identity.ps1", "check-node-version.mjs", "resolve-frontend-dist.mjs"] : ["start.sh", "node-runtime.sh", "check-node-version.mjs", "resolve-frontend-dist.mjs"]) await copyFile(join(root, "scripts", name), join(fixture, "scripts", name));
  const missingArgs = windows ? ["-NoProfile", "-File", join(fixture, "scripts", "start.ps1")] : [join(fixture, "scripts", "start.sh")];
  const missing = spawnSync(executable, missingArgs, { env, encoding: "utf8", timeout: 10000 });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /production build missing/i);
  // A foreign listener must survive stop with missing and stale state.
  listener = spawn(process.execPath, ["-e", 'require("net").createServer().listen(Number(process.argv[1]),"127.0.0.1")', String(port)], { env, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    const result = await new Promise((resolve) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); });
    if (result) break;
    await delay(50);
  }
  const conflict = spawnSync(executable, [...prefix, "doctor"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
  assert.equal(conflict.status, 1, conflict.stdout + conflict.stderr);
  assert.match(conflict.stdout, /\[FAIL\] Control port/);
  command(["stop"], windows ? 1 : 0);
  assert.equal(listener.exitCode, null, "stop killed foreign listener without state");
  if (windows) {
    await mkdir(join(root, ".runtime", "pi-science"), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ checkout: root.replace(/[\\/]$/, ""), mode: "production", control_pid: listener.pid, control_started: "0", launch_token: "a".repeat(32) }));
    command(["stop"], 1);
    assert.equal(listener.exitCode, null, "stale state killed foreign listener");
    await rm(stateFile);
  }
  listener.kill();
  await new Promise((resolve) => listener.once("exit", resolve));
  listener = undefined;
  assert.match(command(["doctor"]), /Ready to start/);
  launcher = spawn(executable, [...prefix, "start", ...(windows ? [] : ["--detach", "--no-open"])], { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] });
  launcher.stdout.on("data", (data) => { output += data; });
  launcher.stderr.on("data", (data) => { output += data; });
  const url = `http://127.0.0.1:${port}`;
  let response;
  for (let i = 0; i < 400; i++) {
    try { response = await fetch(`${url}/internal/ready`, { signal: AbortSignal.timeout(1000) }); if (response.ok) break; } catch { }
    if (launcher.exitCode !== null && launcher.exitCode !== 0) throw new Error(output);
    await delay(100);
  }
  assert(response?.ok, output);
  assert.equal((await response.json()).sqlite.status, "ready");
  const page = await fetch(url);
  assert(page.ok);
  const html = await page.text();
  assert.match(html, /<html/);
  const cookie = page.headers.get("set-cookie");
  assert(cookie?.includes("HttpOnly"), "frontend did not issue internal cookie");
  const asset = /(?:src|href)="(\/assets\/[^" ]+\.js)"/.exec(html)?.[1];
  assert(asset, "built frontend asset missing");
  assert((await fetch(url + asset)).ok, "frontend asset unavailable");
  assert.equal(await (await fetch(url + "/sessions/deep-link")).text(), html, "SPA fallback failed");
  const health = await fetch(url + "/api/health", { headers: { cookie: cookie.split(";")[0] } });
  assert(health.ok, "authenticated API is unavailable");
  // Readiness precedes launcher transaction commit; wait for state publication.
  for (let i = 0; i < 100; i++) {
    try { if (windows) { JSON.parse(await readFile(stateFile, "utf8")); } else { await readFile(join(stateFile, "pid")); } break; } catch { await delay(50); }
  }
  if (!windows) {
    for (let i = 0; i < 100 && launcher.exitCode === null; i++) await delay(50);
    assert.equal(launcher.exitCode, 0, output);
  }
  assert.match(command(["status"]), /RUNNING|Supervisor:\s+running/);
  if (windows) {
    const original = await readFile(stateFile, "utf8");
    const state = JSON.parse(original);
    state.control_started = "0";
    await writeFile(stateFile, JSON.stringify(state));
    command(["stop"], 1);
    assert((await fetch(url + "/internal/ready")).ok, "PID reuse fence did not protect process");
    await writeFile(stateFile, original);
  }
  command(["stop"]);
  for (let i = 0; i < 100; i++) {
    try { const s = net.createServer(); await new Promise((resolve, reject) => { s.once("error", reject); s.listen(port, "127.0.0.1", resolve); }); await new Promise((resolve) => s.close(resolve)); break; }
    catch { if (i === 99) throw new Error("stop did not release production port"); await delay(100); }
  }
  console.log("Production smoke passed: doctor, SQLite readiness, static assets, SPA, authenticated API, owned stop and foreign-process protection.");
} catch (error) { console.error(output); throw error; }
finally {
  listener?.kill();
  try { command(["stop"]); } catch { }
  if (launcher?.exitCode === null) launcher.kill();
  await rm(temporary, { recursive: true, force: true });
}
