import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import * as sandboxProcess from "./process.js";
import { identifyPolicy } from "./policy.js";
import { sandboxBashTool } from "../agent/worker/sandbox-bash.js";
import { executionRepository } from "../executions/execution-repository.js";

// The launcher is a POSIX watchdog: it execs /bin/sh, uses process groups and
// signals. Windows has no sandbox backend to exercise.
describe.skipIf(!["darwin", "linux"].includes(process.platform))("launcher setup timing", () => {
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "setup-timing-")));
  vi.stubEnv("PI_SCIENCE_HOME", join(root, "private")); vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", ""); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function launcher(command: string, timeoutSeconds = 2, setupTimeoutSeconds = 30, networkDelay = 0) {
  const control = join(root, `control-${Math.random()}`); await mkdir(control);
  const phasePath = join(control, "phase.json"), manifest = join(control, "launch.json"), shell = join(control, "bash"), cli = join(control, "cli.mjs"), settings = join(control, "settings.json");
  // Exercise the real watchdog without OS confinement or listening network sockets.
  const network = `data:text/javascript,${encodeURIComponent(`export async function startSandboxNetwork() { await new Promise(r => setTimeout(r, ${networkDelay})); return {httpPort: 0, socksPort: 0, close: async () => {}}; }`)}`;
  const source = (await readFile(sandboxProcess.launcherPath, "utf8")).replaceAll("process.platform", '"test"').replace('new URL(import.meta.url.endsWith(".ts") ? "./network.ts" : "./network.js", import.meta.url).href', JSON.stringify(network)).replace('new URL(import.meta.url.endsWith(".ts") ? "./network-grant-state.ts" : "./network-grant-state.js", import.meta.url).href', JSON.stringify("data:text/javascript,export const networkGrantSource = () => undefined"));
  const watchdog = join(control, "launcher.ts"); await writeFile(watchdog, source);
  await writeFile(cli, 'import { spawn } from "node:child_process"; const args = process.argv.slice(process.argv.indexOf("sandbox-env") + 1); const child = spawn(args[0], args.slice(1), {stdio: "inherit"}); child.on("close", code => process.exit(code ?? 1));');
  await writeFile(settings, JSON.stringify({ network: { deniedDomains: ["*"] } }));
  await writeFile(manifest, JSON.stringify({ cli, settings, argv: ["/bin/bash", "--noprofile", "--norc"], env: {}, timeoutSeconds, setupTimeoutSeconds, phasePath }));
  await writeFile(shell, `#!/bin/sh\nexec '${process.execPath}' '${watchdog}' '${manifest}' "$@"\n`, { mode: 0o700 });
  return { manifest, shell, phasePath, command, env: {}, timing: { settings_ms: 0, credential_scan_ms: 0, credential_directories: 0, credential_entries: 0, prepare_ms: 0 }, cleanup: async () => {} };
}
async function run(prepared: Awaited<ReturnType<typeof launcher>>) {
  const child = spawn(prepared.shell, ["-c", prepared.command], { detached: true, stdio: "ignore" });
  return new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
}
it("records started before spawned and keeps setup outside the command deadline", async () => {
  const prepared = await launcher("sleep 0.05", 0.15, 2, 250);
  expect(await run(prepared)).toBe(0);
  const marks = JSON.parse(await readFile(prepared.phasePath, "utf8"));
  expect(marks.spawned).toBeGreaterThan(marks.started); expect(marks.closed).toBeGreaterThanOrEqual(marks.spawned);
  expect(await sandboxProcess.readLauncherTiming(prepared.phasePath)).toMatchObject({ started_at: marks.started, spawned_at: marks.spawned, terminal: "closed" });
});
it.skipIf(!["darwin", "linux"].includes(process.platform))("reports finite preparation timings and counts each credential directory once", async () => {
  const cwd = join(root, "workspace"); await mkdir(join(cwd, "nested", "deep"), { recursive: true }); await writeFile(join(cwd, "nested", "deep", ".env"), "SECRET");
  const policy = identifyPolicy({ mode: "required", scope: "workspace", cwd, readPaths: [cwd], writePaths: [cwd], denyPaths: [], network: { mode: "none" } });
  const prepared = await sandboxProcess.prepareSandbox(policy, ["/bin/true"], [], 1);
  try {
    for (const value of [prepared.timing.settings_ms, prepared.timing.credential_scan_ms, prepared.timing.prepare_ms]) { expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0); }
    expect(prepared.timing.credential_directories).toBe(4); expect(prepared.timing.credential_entries).toBe(3);
  } finally { await prepared.cleanup(); }
});
it("records command_timeout and names the command phase in the invocation error", async () => {
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const prepared = await launcher("sleep 5", 0.1);
  vi.spyOn(sandboxProcess, "prepareSandbox").mockResolvedValue(prepared);
  const invocation = { operationId: "op", invocationId: "timeout", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
  await expect(sandboxBashTool({ cwd, sessionId: "session" }).execute("timeout", { command: prepared.command, timeout: 0.1 }, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, BACKGROUND_CONTEXT)).rejects.toThrow("sandbox launcher: command_timeout");
  const marks = JSON.parse(await readFile(prepared.phasePath, "utf8")); expect(marks.command_timeout).toBeGreaterThanOrEqual(marks.spawned); expect(marks.setup_timeout).toBeUndefined();
  const record = (await executionRepository.list(cwd))[0]!; expect(record.status).toBe("timed_out");
  expect(record.result).toMatchObject({ sandbox_setup: { policy_ms: expect.any(Number), launcher: { terminal: "command_timeout" } } });
});
it("records setup_timeout separately before a command is spawned", async () => {
  const prepared = await launcher("true", 2, 0.05, 250); await run(prepared);
  const marks = JSON.parse(await readFile(prepared.phasePath, "utf8")); expect(marks.setup_timeout).toBeGreaterThanOrEqual(marks.started); expect(marks.spawned).toBeUndefined(); expect(marks.command_timeout).toBeUndefined();
});
it("degrades missing and unreadable phase evidence to no launcher object", async () => {
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const prepared = await launcher("true");
  const manifest = JSON.parse(await readFile(prepared.manifest, "utf8")); manifest.phasePath = root; await writeFile(prepared.manifest, JSON.stringify(manifest));
  vi.spyOn(sandboxProcess, "prepareSandbox").mockResolvedValue(prepared);
  const invocation = { operationId: "op", invocationId: "missing", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} };
  await sandboxBashTool({ cwd, sessionId: "session" }).execute("missing", { command: "true" }, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, BACKGROUND_CONTEXT);
  const record = (await executionRepository.list(cwd))[0]!; expect(record.status).toBe("succeeded");
  expect(record.result).toHaveProperty("sandbox_setup.policy_ms"); expect(record.result).not.toHaveProperty("sandbox_setup.launcher");
  expect(await sandboxProcess.readLauncherTiming(join(root, "missing.json"))).toBeUndefined();
  expect(await sandboxProcess.readLauncherTiming(root)).toBeUndefined();
  await writeFile(join(root, "broken.json"), "broken"); expect(await sandboxProcess.readLauncherTiming(join(root, "broken.json"))).toBeUndefined();
});
});
