import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkLinuxSeccomp, probeLinuxSandbox, resolveSandboxTool } from "./check-linux-sandbox.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi sandbox preflight "));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function executable(path, body = "exit 0") {
  await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o755);
}
test("discovers a helper outside /usr/bin and resolves its symlink", { skip: process.platform !== "linux" }, async () => fixture(async (root) => {
  await executable(join(root, "actual-rg"));
  await symlink(join(root, "actual-rg"), join(root, "rg"));
  assert.equal(await resolveSandboxTool("rg", { PATH: root }), await realpath(join(root, "actual-rg")));
}));
test("missing helpers give installation instructions; invalid overrides never fall back", { skip: process.platform !== "linux" }, async () => fixture(async (root) => {
  await assert.rejects(resolveSandboxTool("socat", { PATH: root }), /apt-get install ripgrep socat bubblewrap/);
  await executable(join(root, "rg"));
  await assert.rejects(resolveSandboxTool("rg", { PATH: root, PI_SCIENCE_SANDBOX_RIPGREP: join(root, "missing") }), /not executable/);
  await assert.rejects(resolveSandboxTool("rg", { PATH: root, PI_SCIENCE_SANDBOX_RIPGREP: "rg" }), /absolute executable path/);
  await chmod(join(root, "rg"), 0o644);
  await assert.rejects(resolveSandboxTool("rg", { PATH: root }), /not found/);
  await assert.rejects(resolveSandboxTool("socat", { PATH: root, PI_SCIENCE_SANDBOX_SOCAT: root }), /not executable/);
}));
test("probe creates user/PID/network namespaces with a read-only root and a bounded timeout", () => {
  let invocation;
  probeLinuxSandbox("/custom/bwrap", (...args) => { invocation = args; return { status: 0 }; });
  assert.equal(invocation[0], "/custom/bwrap");
  assert.deepEqual(invocation[1], ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net", "--cap-drop", "ALL", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"]);
  assert.equal(invocation[2].timeout, 10_000);
  assert.equal(invocation[2].killSignal, "SIGKILL");
});
test("probe fails closed on namespace denial, timeout, or launch failure", () => {
  for (const result of [{ status: 1, stderr: "Creating new namespace failed: Operation not permitted" }, { status: null, error: new Error("ETIMEDOUT") }, { status: null, error: new Error("ENOENT") }]) {
    assert.throws(() => probeLinuxSandbox("/custom/bwrap", () => result), /startup check failed.*\nBubblewrap must be allowed/);
  }
});
test("shell preflight exports canonical helper paths and propagates probe errors", { skip: process.platform !== "linux" }, async () => fixture(async (root) => {
  for (const tool of ["rg", "socat", "bwrap"]) await executable(join(root, tool));
  const environment = { ...process.env, PI_SCIENCE_EXECUTION_MODE: "required", PI_SCIENCE_SANDBOX_RIPGREP: join(root, "rg"), PI_SCIENCE_SANDBOX_SOCAT: join(root, "socat"), PI_SCIENCE_SANDBOX_BWRAP: join(root, "bwrap") };
  const run = () => spawnSync("/bin/bash", [join(scripts, "fixtures/sandbox-preflight.sh"), join(scripts, "sandbox-prerequisites.sh"), process.execPath, "report"], { env: environment, encoding: "utf8", timeout: 15_000 });
  const passed = run(); assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(JSON.parse(passed.stdout.trim().split("\n").at(-1)), { rg: await realpath(join(root, "rg")), socat: await realpath(join(root, "socat")), bwrap: await realpath(join(root, "bwrap")) });
  await executable(join(root, "bwrap"), "echo 'namespace denied' >&2; exit 1");
  const denied = run(); assert.notEqual(denied.status, 0); assert.match(denied.stderr, /namespace denied/);
}));
test("installer stops before package installation when a helper is missing", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync("/bin/bash", [join(scripts, "install.sh")], { env: { ...process.env, PI_SCIENCE_EXECUTION_MODE: "required", PI_SCIENCE_SANDBOX_RIPGREP: process.execPath, PI_SCIENCE_SANDBOX_SOCAT: "/missing/pi-science/socat" }, encoding: "utf8", timeout: 15_000 });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /PI_SCIENCE_SANDBOX_SOCAT.*not executable/);
  assert.doesNotMatch(result.stdout, /Installing JavaScript|Building production|Installation complete/);
});
test("launcher refuses to start services when the namespace probe fails", { skip: process.platform !== "linux" }, async () => fixture(async (root) => {
  const copiedScripts = join(root, "scripts"); await mkdir(copiedScripts);
  for (const name of ["start.sh", "node-runtime.sh", "check-node-version.mjs", "sandbox-prerequisites.sh", "check-linux-sandbox.mjs"]) await copyFile(join(scripts, name), join(copiedScripts, name));
  await mkdir(join(root, "apps/server/node_modules/tsx/dist"), { recursive: true });
  await writeFile(join(root, "apps/server/node_modules/tsx/dist/cli.mjs"), 'throw new Error("Service must not start")');
  await mkdir(join(root, "frontend/node_modules/.bin"), { recursive: true });
  await executable(join(root, "frontend/node_modules/.bin/vite"));
  for (const tool of ["rg", "socat"]) await executable(join(root, tool));
  await executable(join(root, "bwrap"), "echo 'namespace denied' >&2; exit 1");
  const result = spawnSync("/bin/bash", [join(copiedScripts, "start.sh")], { env: { ...process.env, PI_SCIENCE_EXECUTION_MODE: "required", PI_SCIENCE_MODE: "dev", PI_SCIENCE_SANDBOX_RIPGREP: join(root, "rg"), PI_SCIENCE_SANDBOX_SOCAT: join(root, "socat"), PI_SCIENCE_SANDBOX_BWRAP: join(root, "bwrap") }, encoding: "utf8", timeout: 15_000 });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /startup check failed: namespace denied/);
  assert.doesNotMatch(result.stdout + result.stderr, /Starting Node control plane|Service must not start/);
}));

test("explicit trusted-host selection skips the Linux probe without silently changing mode", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync("/bin/bash", [join(scripts, "fixtures/sandbox-preflight.sh"), join(scripts, "sandbox-prerequisites.sh"), process.execPath], { env: { ...process.env, PI_SCIENCE_EXECUTION_MODE: "trusted-host", PI_SCIENCE_SANDBOX_RIPGREP: "/missing/rg" }, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /operator explicitly selected trusted-host/);
});

test("nested probe reports helper denial even when the outer namespace starts", { skip: process.platform !== "linux" }, async () => fixture(async (root) => {
  await executable(join(root, "bwrap"));
  const environment = { PATH: root };
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 1, stderr: "apply-seccomp: write /proc/self/setgroups: Permission denied" }; };
  probeLinuxSandbox(join(root, "bwrap"), () => ({ status: 0 }));
  await assert.rejects(checkLinuxSeccomp(environment, run), /Linux nested seccomp startup check failed: apply-seccomp.*\nBubblewrap.*child processes/);
  assert.equal(calls[0][0], await realpath(join(root, "bwrap")));
  assert.match(calls[0][1].at(-2), /vendor[/\\]seccomp[/\\].*[/\\]apply-seccomp$/);
  assert.equal(calls[0][1].at(-1), "/bin/true");
  assert.equal(calls[0][2].timeout, 10_000);
  assert.equal(calls[0][2].killSignal, "SIGKILL");
  for (const result of [{ status: null, error: new Error("ETIMEDOUT") }, { status: null, error: new Error("ENOENT") }]) {
    await assert.rejects(checkLinuxSeccomp(environment, () => result), /nested seccomp startup check failed/);
  }
  await checkLinuxSeccomp(environment, () => ({ status: 0 }));
}));
