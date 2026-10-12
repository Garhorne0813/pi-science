#!/usr/bin/env node
import { access, stat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { resolveFrontendDist } from "./resolve-frontend-dist.mjs";

export function supportedNode(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!parts && (Number(parts[1]) > 24 || (Number(parts[1]) === 24 && Number(parts[2]) >= 16));
}
export function parsePort(raw, fallback) {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("must be an integer between 1 and 65535");
  return value;
}
export async function writableDirectory(path) {
  let current = resolve(path);
  while (true) {
    try {
      const info = await stat(current);
      if (!info.isDirectory()) throw new Error(`${current} is not a directory`);
      await access(current, constants.W_OK | constants.X_OK);
      return current === resolve(path) ? "writable" : "parent writable; created on start";
    } catch (error) {
      if (error.code !== "ENOENT" || dirname(current) === current) throw error;
      current = dirname(current);
    }
  }
}
export async function instanceLockAvailable(home) {
  const path = join(home, "instance.lock");
  let text, info;
  try { text = await readFile(path, "utf8"); info = await stat(path); }
  catch (error) { if (error.code === "ENOENT") return "clear"; throw error; }
  let owner;
  try { owner = JSON.parse(text); } catch { owner = {}; }
  if (Number.isInteger(owner.pid) && owner.pid > 0) {
    let live = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") live = false; }
    if (live) throw new Error("instance owner is still running; stop the verified instance first");
  }
  if (Date.now() - info.mtimeMs < 30000) throw new Error("recent instance lock; wait 30 seconds after a crash or forced stop, then retry");
  return "stale lock can be reclaimed on start";
}
export function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(() => resolve("available")));
  });
}
export async function doctor(args = [], env = process.env) {
  if (args.some((arg) => arg !== "--dev")) throw new Error("Usage: pi-science doctor [--dev]");
  const dev = args.includes("--dev") || env.PI_SCIENCE_MODE === "dev";
  const root = fileURLToPath(new URL("../", import.meta.url));
  const results = [];
  const check = async (label, fn, required = true) => {
    try { results.push({ label, status: "ok", detail: await fn() }); }
    catch (error) { results.push({ label, status: required ? "fail" : "optional", detail: error.message }); }
  };
  await check("Node.js", () => {
    if (!supportedNode(process.versions.node)) throw new Error(`found ${process.versions.node}; install Node.js >=24.16.0`);
    return process.versions.node;
  });
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  // No package-manager invocation: even --version may auto-download via Corepack.
  results.push({ label: "Package manager", status: "optional", detail: `${metadata.packageManager}; installer bootstraps via npm (not required to start)` });
  await check("Git", () => {
    const result = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 3000 });
    if (result.status !== 0) throw new Error("not available; needed only to clone/update source");
    return result.stdout.trim();
  }, false);
  await check("Application build", async () => {
    const paths = dev
      ? ["apps/server/node_modules/tsx/dist/cli.mjs", "frontend/node_modules/vite/bin/vite.js"]
      : ["apps/server/dist/app/main.js", "apps/server/dist/runtime/agent/worker/main.js", "apps/server/dist/storage/sqlite/sqlite-worker.js", "frontend/dist/index.html"];
    if (!dev && env.PI_SCIENCE_FRONTEND_DIST) paths[paths.length - 1] = join(resolveFrontendDist(root, env.PI_SCIENCE_FRONTEND_DIST), "index.html");
    for (const path of paths) {
      try { if (!(await stat(resolve(root, path))).isFile()) throw new Error("not a file"); }
      catch { throw new Error(`missing ${path}; run the platform installer`); }
    }
    const require = createRequire(join(root, "apps/server/package.json"));
    require.resolve("fastify");
    require.resolve("@pi-science/contracts");
    return dev ? "source dependencies present" : "server, worker, SQLite worker and frontend present";
  });
  for (const [label, raw, fallback] of [["Control port", env.PI_SCIENCE_CONTROL_PLANE_PORT, 8787], ...(dev ? [["Frontend port", env.PI_SCIENCE_FRONTEND_PORT, 5173]] : [])]) {
    await check(label, async () => { const port = parsePort(raw, fallback); await portAvailable(port); return `${port} available`; });
  }
  await check("Instance lock", () => instanceLockAvailable(env.PI_SCIENCE_HOME || join(homedir(), ".pi-science")));
  await check("Data directory", () => writableDirectory(env.PI_SCIENCE_HOME || join(homedir(), ".pi-science")));
  await check("Workspaces", () => writableDirectory(env.PI_SCIENCE_WORKSPACES || join(homedir(), "pi-science-workspaces")));
  await check("SQLite runtime", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(":memory:");
    try { database.prepare("SELECT 1").get(); } finally { database.close(); }
    return "in-memory query passed; persistent database checked on startup";
  });
  results.push({ label: "Python / R / Micromamba", status: "optional", detail: "scientific environments are provisioned on demand" });
  results.push({ label: "LLM provider", status: "optional", detail: "configure in Settings > LLM before a conversation" });
  for (const result of results) console.log(`${result.status === "ok" ? "[OK]" : result.status === "fail" ? "[FAIL]" : "[INFO]"} ${result.label}: ${result.detail}`);
  const ready = !results.some((result) => result.status === "fail");
  console.log(ready ? `Result: Ready to start\nNext: pi-science start${dev ? " --dev" : ""}` : "Result: Resolve the failures above, then run doctor again.");
  return ready;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await doctor(process.argv.slice(2))) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
