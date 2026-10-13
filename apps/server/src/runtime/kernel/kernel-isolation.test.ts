import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeKernelManager } from "./node-kernel-manager.js";
import { KernelIsolationUnavailableError, planKernelLaunch, type KernelIsolationPolicy, type KernelLaunchRequest } from "./kernel-isolation.js";
import type { WorkspaceEnvironmentStatus } from "../workspace/workspace-environment.js";

function systemPython(): string | null {
  const commands = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const command of commands) {
    const result = spawnSync(command, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return null;
}

const python = systemPython();
const hasEnforcer = process.platform === "darwin" && await access("/usr/bin/sandbox-exec", constants.X_OK).then(() => true, () => false);
const cleanup: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

function environmentPaths(prefix: string): { bin: string; python: string; pip: string } {
  const bin = join(prefix, process.platform === "win32" ? "Scripts" : "bin");
  const suffix = process.platform === "win32" ? ".exe" : "";
  return { bin, python: join(bin, `python${suffix}`), pip: join(bin, `pip${suffix}`) };
}

async function createTestEnvironment(prefix: string): Promise<void> {
  const paths = environmentPaths(prefix);
  await mkdir(paths.bin, { recursive: true });
  await symlink(python!, paths.python);
}

function status(workspace: string, prefix: string): WorkspaceEnvironmentStatus {
  const paths = environmentPaths(prefix);
  return {
    ready: true,
    workspace,
    prefix,
    python: paths.python,
    pip: paths.pip,
    environment_id: "env_test",
    revision_id: "rev_test",
    manager: "micromamba",
    npm: { local_prefix: workspace, global_prefix: join(workspace, ".pi-science", "npm-global"), cache: join(workspace, ".pi-science", "cache", "npm") },
  };
}

async function listenOnLoopback(): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Loopback listener did not bind");
  return address.port;
}

function escapeCell(workspace: string, outsideSecret: string, outsideTarget: string, port: number): string {
  return [
    "import json, os, socket, subprocess, sys",
    `outside_secret = ${JSON.stringify(outsideSecret)}`,
    `outside_target = ${JSON.stringify(outsideTarget)}`,
    `workspace_target = ${JSON.stringify(join(workspace, "written-by-cell.txt"))}`,
    `workspace_metadata = ${JSON.stringify(join(workspace, ".pi-science", "provenance.jsonl"))}`,
    `child_program = ${JSON.stringify(`import socket; socket.create_connection(("127.0.0.1", ${port}), 2)`.replace(/"/g, "'"))}`,
    "outcome = {}",
    "def attempt(name, run):",
    "    try:",
    "        run()",
    "        outcome[name] = 'allowed'",
    "    except Exception as error:",
    "        outcome[name] = type(error).__name__",
    "attempt('read_outside', lambda: open(outside_secret).read())",
    "attempt('write_outside', lambda: open(outside_target, 'w').write('x'))",
    "attempt('read_workspace_metadata', lambda: open(workspace_metadata).read())",
    "attempt('network', lambda: socket.create_connection(('127.0.0.1', " + port + "), 2))",
    "attempt('subprocess_network', lambda: subprocess.run([sys.executable, '-c', child_program], check=True, capture_output=True, timeout=8))",
    "attempt('workspace_write', lambda: open(workspace_target, 'w').write('ok'))",
    "attempt('devnull_write', lambda: open(os.devnull, 'w').write('x'))",
    "attempt('devnull_subprocess', lambda: subprocess.run([sys.executable, '-c', 'print(1)'], stdout=subprocess.DEVNULL, check=True, timeout=8))",
    "print(json.dumps(outcome))",
  ].join("\n");
}

async function escapeOutcome(code: string, workspace: string, prefix: string, isolation: KernelIsolationPolicy): Promise<Record<string, string | null>> {
  const manager = new NodeKernelManager({ isolation });
  try {
    const result = await manager.execute({ language: "python", code, cwd: workspace, environment: status(workspace, prefix), timeoutMs: 30_000 });
    expect(result.ok, result.error ?? "").toBe(true);
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    return JSON.parse(line) as Record<string, string | null>;
  } finally {
    await manager.shutdownAll();
  }
}

describe("kernel cell escapes", () => {
  it.skipIf(python === null)("reaches the network and the filesystem outside the workspace without an isolation profile", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-kernel-isolation-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-science-kernel-outside-"));
    cleanup.push(workspace, outside);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await writeFile(join(workspace, ".pi-science", "provenance.jsonl"), "protected\n", "utf8");
    const outsideSecret = join(outside, "secret.txt");
    const outsideTarget = join(outside, "written.txt");
    await writeFile(outsideSecret, "outside\n", "utf8");
    const port = await listenOnLoopback();

    const outcome = await escapeOutcome(escapeCell(workspace, outsideSecret, outsideTarget, port), workspace, prefix, "unconfined");

    expect(outcome).toMatchObject({
      read_outside: "allowed",
      write_outside: "allowed",
      read_workspace_metadata: "allowed",
      network: "allowed",
      subprocess_network: "allowed",
      workspace_write: "allowed",
      devnull_write: "allowed",
      devnull_subprocess: "allowed",
    });
  });

  it.skipIf(python === null || !hasEnforcer)("denies filesystem and network escapes while allowing workspace writes", async () => {
    const fixture = await isolationFixture();
    const outcome = await escapeOutcome(escapeCell(fixture.workspace, fixture.secret, fixture.target, await listenOnLoopback()), fixture.workspace, fixture.prefix, "workspace");
    for (const name of ["read_outside", "write_outside", "read_workspace_metadata", "network"]) expect(outcome[name], name).toBe("PermissionError");
    expect(outcome.subprocess_network).toBe("CalledProcessError");
    for (const name of ["workspace_write", "devnull_write", "devnull_subprocess"]) expect(outcome[name], name).toBe("allowed");
  });

  it.skipIf(python === null || !hasEnforcer)("allows explicit network access without allowing filesystem escapes", async () => {
    const fixture = await isolationFixture();
    const outcome = await escapeOutcome(escapeCell(fixture.workspace, fixture.secret, fixture.target, await listenOnLoopback()), fixture.workspace, fixture.prefix, "workspace-network");
    expect(outcome.network).toBe("allowed");
    expect(outcome.subprocess_network).toBe("allowed");
    for (const name of ["read_outside", "write_outside", "read_workspace_metadata"]) expect(outcome[name], name).toBe("PermissionError");
    expect(outcome.workspace_write).toBe("allowed");
  });

  it.skipIf(python === null || !hasEnforcer)("strips app and provider credentials while preserving PATH", async () => {
    const fixture = await isolationFixture();
    vi.stubEnv("PI_SCIENCE_INTERNAL_TOKEN", "sentinel-internal-token");
    vi.stubEnv("OPENAI_API_KEY", "sentinel-provider-key");
    const outcome = await escapeOutcome("import os, json\nprint(json.dumps({key: os.environ.get(key) for key in ['PI_SCIENCE_INTERNAL_TOKEN', 'OPENAI_API_KEY', 'PATH']}))", fixture.workspace, fixture.prefix, "workspace");
    expect(outcome.PI_SCIENCE_INTERNAL_TOKEN).toBeNull();
    expect(outcome.OPENAI_API_KEY).toBeNull();
    expect(outcome.PATH).toContain(fixture.prefix);
  });

  it.skipIf(python === null || !hasEnforcer)("keeps a relocated runtime readable but read-only and grants private scratch", async () => {
    const fixture = await isolationFixture(true);
    const protectedFile = join(fixture.outside, "app-state", "protected.json");
    await writeFile(protectedFile, "protected", "utf8");
    const code = [
      "import json, ssl, tempfile",
      "outcome = {}",
      "def attempt(name, run):",
      "    try:",
      "        run()",
      "        outcome[name] = 'allowed'",
      "    except Exception as error:",
      "        outcome[name] = type(error).__name__",
      `attempt('app_read', lambda: open(${JSON.stringify(protectedFile)}).read())`,
      `attempt('runtime_write', lambda: open(${JSON.stringify(join(fixture.prefix, "written.txt"))}, 'w').write('x'))`,
      "attempt('scratch_write', lambda: tempfile.TemporaryFile().write(b'x'))",
      "print(json.dumps(outcome))",
    ].join("\n");
    const outcome = await escapeOutcome(code, fixture.workspace, fixture.prefix, "workspace");
    expect(outcome.app_read).toBe("PermissionError");
    expect(outcome.runtime_write).toBe("PermissionError");
    expect(outcome.scratch_write).toBe("allowed");
  });

  it.skipIf(python === null || !hasEnforcer)("denies the app state root even when it sits inside the workspace", async () => {
    const fixture = await isolationFixture();
    const stateRoot = join(fixture.workspace, "app-state");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "sentinel.json"), "protected", "utf8");
    await writeFile(join(fixture.workspace, "readable.txt"), "public", "utf8");
    vi.stubEnv("PI_SCIENCE_HOME", stateRoot);
    const code = [
      "import json",
      "outcome = {}",
      "def attempt(name, run):",
      "    try:",
      "        run()",
      "        outcome[name] = 'allowed'",
      "    except Exception as error:",
      "        outcome[name] = type(error).__name__",
      `attempt('app_state_read', lambda: open(${JSON.stringify(join(stateRoot, "sentinel.json"))}).read())`,
      `attempt('app_state_write', lambda: open(${JSON.stringify(join(stateRoot, "written.json"))}, 'w').write('x'))`,
      `attempt('workspace_read', lambda: open(${JSON.stringify(join(fixture.workspace, "readable.txt"))}).read())`,
      "print(json.dumps(outcome))",
    ].join("\n");
    const outcome = await escapeOutcome(code, fixture.workspace, fixture.prefix, "workspace");
    expect(outcome.app_state_read).toBe("PermissionError");
    expect(outcome.app_state_write).toBe("PermissionError");
    expect(outcome.workspace_read).toBe("allowed");
  });

  it.skipIf(python === null || !hasEnforcer)("preserves the namespace and recovers after an in-cell interrupt", async () => {
    const fixture = await isolationFixture();
    const manager = new NodeKernelManager({ isolation: "workspace" });
    const options = { language: "python" as const, cwd: fixture.workspace, environment: status(fixture.workspace, fixture.prefix), notebookId: "nb-isolated", timeoutMs: 10_000 };
    try {
      expect((await manager.execute({ ...options, code: "answer = 41" })).ok).toBe(true);
      expect((await manager.execute({ ...options, code: "answer + 1" })).result).toBe("42");
      let ready!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      const running = manager.execute({ ...options, code: "import time\nprint('interrupt-ready')\ntime.sleep(30)", onEvent: (event) => { if (event.text.includes("interrupt-ready")) ready(); } });
      await started;
      expect(await manager.interruptNotebook("nb-isolated", fixture.workspace)).toBe(true);
      expect((await running).interrupted).toBe(true);
      const followup = await manager.execute({ ...options, code: "answer + 1" });
      expect(followup.ok).toBe(true);
      expect(followup.result).toBe("42");
    } finally { await manager.shutdownAll(); }
  });
});

async function isolationFixture(relocatedEnvironment = false) {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-science-isolation-"quoted)-'));
  const outside = await mkdtemp(join(tmpdir(), "pi-science-isolation-outside-"));
  cleanup.push(workspace, outside);
  vi.stubEnv("PI_SCIENCE_HOME", join(outside, "app-state"));
  const prefix = relocatedEnvironment ? join(outside, "app-state", "env") : join(workspace, "env");
  await createTestEnvironment(prefix);
  await mkdir(join(workspace, ".pi-science"), { recursive: true });
  await writeFile(join(workspace, ".pi-science", "provenance.jsonl"), "protected\n", "utf8");
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "outside\n", "utf8");
  return { workspace, outside, prefix, secret, target: join(outside, "written.txt") };
}

const bareRequest: KernelLaunchRequest = { platform: "linux", workspace: "/missing-workspace", environmentPrefix: "/missing-env", interpreter: "/missing-python", bridge: "/missing-bridge", env: { OPENAI_API_KEY: "unchanged", HOME: "/original-home", PATH: "/original-path" } };

describe("kernel launch planning", () => {
  const platforms: NodeJS.Platform[] = ["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"];
  it.each(platforms)("leaves an unconfined launch unchanged on %s without filesystem work", async (platform) => {
    const launch = await planKernelLaunch("unconfined", { ...bareRequest, platform, codeFile: "/missing-cell.R" });
    expect(launch.command).toBe("/missing-python");
    expect(launch.args).toEqual(["/missing-bridge", "/missing-cell.R"]);
    expect(launch.env).toBe(bareRequest.env);
    await launch.dispose();
    await launch.dispose();
  });

  it.each(["linux", "win32"] as const)("fails closed on %s with an actionable escape hatch", async (platform) => {
    for (const policy of ["workspace", "workspace-network"] as const) {
      const error = await planKernelLaunch(policy, { ...bareRequest, platform }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(KernelIsolationUnavailableError);
      expect(error).toMatchObject({ platform, message: expect.stringContaining("PI_SCIENCE_KERNEL_ISOLATION=unconfined") });
    }
  });

  it.skipIf(python === null || !hasEnforcer)("canonicalizes metadata paths before they exist", async () => {
    const fixture = await isolationFixture();
    await rm(join(fixture.workspace, ".pi-science"), { recursive: true });
    const launch = await planKernelLaunch("workspace", { ...bareRequest, platform: "darwin", workspace: fixture.workspace, environmentPrefix: fixture.prefix, interpreter: status(fixture.workspace, fixture.prefix).python, bridge: fixture.secret });
    try { expect(launch.args[1]).toContain(`(subpath ${JSON.stringify(join(await realpath(fixture.workspace), ".pi-science"))})`); }
    finally { await launch.dispose(); }
  });

  it.skipIf(python === null || !hasEnforcer)("wraps sandbox-exec with canonical paths, ordered carve-outs and private scratch", async () => {
    const fixture = await isolationFixture();
    const codeFile = join(fixture.workspace, ".pi-science", "cell.R");
    await writeFile(codeFile, "", "utf8");
    const env: NodeJS.ProcessEnv = { ...bareRequest.env, PI_SCIENCE_INTERNAL_TOKEN: "secret", custom_token: "secret", DB_PASSWORD: "secret", AWS_ACCESS_KEY: "secret", SIGNING_PRIVATE_KEY: "secret", CLIENT_SECRET: "secret", HF_HOME: "keep" };
    const request = { platform: "darwin" as const, workspace: fixture.workspace, environmentPrefix: fixture.prefix, interpreter: status(fixture.workspace, fixture.prefix).python, bridge: codeFile, codeFile, env };
    const launch = await planKernelLaunch("workspace", request);
    try {
      expect(launch.command).toBe("/usr/bin/sandbox-exec");
      expect(launch.args[0]).toBe("-p");
      expect(launch.args.slice(2)).toEqual([request.interpreter, codeFile, codeFile]);
      const profile = launch.args[1]!;
      const canonicalWorkspace = await realpath(fixture.workspace);
      expect(profile).toContain(`(subpath ${JSON.stringify(canonicalWorkspace)})`);
      if (fixture.workspace.startsWith("/var/")) expect(canonicalWorkspace).toMatch(/^\/private\/var\//);
      if (canonicalWorkspace !== fixture.workspace) expect(profile).not.toContain(`(subpath ${JSON.stringify(fixture.workspace)})`);
      const metadata = await realpath(join(fixture.workspace, ".pi-science"));
      expect(profile.indexOf(`(deny file-read*`)).toBeGreaterThan(profile.indexOf(`(subpath ${JSON.stringify(canonicalWorkspace)})`));
      expect(profile).toContain(`(subpath ${JSON.stringify(metadata)})`);
      const literal = `(literal ${JSON.stringify(await realpath(codeFile))})`;
      expect(profile.lastIndexOf(literal)).toBeGreaterThan(profile.indexOf("(deny file-read*"));
      expect(profile.endsWith("(deny network*)")).toBe(true);
      expect(launch.env).toMatchObject({ HOME: "/original-home", PATH: "/original-path", HF_HOME: "keep", TMP: launch.env.TMPDIR, TEMP: launch.env.TMPDIR });
      for (const key of ["OPENAI_API_KEY", "PI_SCIENCE_INTERNAL_TOKEN", "custom_token", "DB_PASSWORD", "AWS_ACCESS_KEY", "SIGNING_PRIVATE_KEY", "CLIENT_SECRET"]) expect(launch.env).not.toHaveProperty(key);
      expect(env.OPENAI_API_KEY).toBe("unchanged");
      for (const key of ["TMPDIR", "MPLCONFIGDIR", "XDG_CACHE_HOME"]) expect(await realpath(launch.env[key]!)).toBe(launch.env[key]);
      const firstDisposal = launch.dispose();
      expect(launch.dispose()).toBe(firstDisposal);
      await firstDisposal;
      await expect(access(launch.env.TMPDIR!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await launch.dispose(); }
  });
});
