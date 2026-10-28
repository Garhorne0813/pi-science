import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, utimes, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveFrontendDist } from "./resolve-frontend-dist.mjs";
import { supportedNode, parsePort, writableDirectory, portAvailable, instanceLockAvailable } from "./doctor.mjs";

test("runtime versions and invalid port configuration are rejected", () => {
  for (const value of ["24.15.9", "22.20.0", "bad", "24.16"]) assert.equal(supportedNode(value), false);
  for (const value of ["24.16.0", "24.19.0", "25.0.0"]) assert.equal(supportedNode(value), true);
  for (const value of ["0", "65536", "abc", "12.5", "-1"]) assert.throws(() => parsePort(value, 8787));
  assert.equal(parsePort(undefined, 8787), 8787);
});
test("doctor detects port conflicts and frees its own probe", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try { await assert.rejects(portAvailable(port), { code: "EADDRINUSE" }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
  await portAvailable(port);
  await portAvailable(port);
});
test("directory diagnostics accept missing descendants without creating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-science-doctor-"));
  try {
    assert.match(await writableDirectory(join(root, "missing", "data")), /parent writable/);
    const path = join(root, "file");
    await writeFile(path, "data");
    await assert.rejects(writableDirectory(path), /not a directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("instance diagnostics reject active/recent locks and accept reclaimable ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-science-lock-doctor-"));
  const path = join(root, "instance.lock");
  try {
    assert.equal(await instanceLockAvailable(root), "clear");
    await writeFile(path, JSON.stringify({ pid: process.pid }));
    await assert.rejects(instanceLockAvailable(root), /still running/);
    await writeFile(path, "{}");
    await assert.rejects(instanceLockAvailable(root), /wait 30 seconds/);
    const old = new Date(Date.now() - 60000);
    await utimes(path, old, old);
    assert.match(await instanceLockAvailable(root), /reclaimed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("frontend build overrides are anchored to the checkout", () => {
  const root = join(tmpdir(), "checkout with spaces");
  assert.equal(resolveFrontendDist(root, "frontend/dist"), join(root, "frontend", "dist"));
  assert.equal(resolveFrontendDist(root, ""), join(root, "frontend", "dist"));
  const external = join(tmpdir(), "external frontend");
  assert.equal(resolveFrontendDist(root, external), external);
});

test("doctor rejects a denied nested helper and honors explicit trusted-host mode", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor nested seccomp "));
  try {
    for (const name of ["rg", "socat", "bwrap"]) {
      const body = name === "bwrap" ? 'for arg do case "$arg" in */apply-seccomp) echo "nested helper denied" >&2; exit 1;; esac; done' : "exit 0";
      await writeFile(join(root, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(root, name), 0o755);
    }
    const environment = { ...process.env, PI_SCIENCE_HOME: join(root, "missing-data"), PI_SCIENCE_SANDBOX_RIPGREP: join(root, "rg"), PI_SCIENCE_SANDBOX_SOCAT: join(root, "socat"), PI_SCIENCE_SANDBOX_BWRAP: join(root, "bwrap"), PI_SCIENCE_EXECUTION_MODE: "required" };
    const run = (env) => spawnSync(process.execPath, [fileURLToPath(new URL("./doctor.mjs", import.meta.url))], { env, encoding: "utf8", timeout: 15000 });
    const denied = run(environment);
    assert.equal(denied.status, 1, denied.stderr);
    assert.match(denied.stdout, /\[FAIL\] Linux sandbox: Linux nested seccomp startup check failed: nested helper denied/);
    const trusted = run({ ...environment, PI_SCIENCE_EXECUTION_MODE: "trusted-host" });
    assert.match(trusted.stdout, /\[OK\] Linux sandbox: skipped: operator explicitly selected trusted-host mode/);
    assert.doesNotMatch(trusted.stdout, /nested helper denied/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
