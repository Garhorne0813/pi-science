import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeKernelManager, type KernelResult, type KernelExecuteOptions } from "./node-kernel-manager.js";
import type { WorkspaceEnvironmentStatus } from "../workspace/workspace-environment.js";
import * as sandboxPolicies from "../sandbox/policy.js";
import * as sandboxProcesses from "../sandbox/process.js";

function systemPython(): string | null {
  const commands = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const command of commands) {
    const result = spawnSync(command, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return null;
}

const python = systemPython();
const hasMatplotlib = python !== null && spawnSync(python, ["-c", "import matplotlib"], { encoding: "utf8" }).status === 0;
function systemRscript(): string | null {
  // Windows is excluded at the R bridge test below: a copied or linked
  // Rscript.exe derives R_HOME from its own module path, which points into the
  // fixture prefix instead of the real installation.
  if (process.platform === "win32") return null;
  const probe = spawnSync("Rscript", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  // A symlink target resolves against the link's own directory, so the fixture
  // needs an absolute path; the bare command name would point the link at itself.
  const located = spawnSync("which", ["Rscript"], { encoding: "utf8" });
  const absolute = located.status === 0 ? located.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : undefined;
  return absolute ?? null;
}

const rscript = systemRscript();
const cleanup: string[] = [];

// These characterize explicitly authorized native execution. Required-mode tests live in sandbox/.
beforeEach(() => vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host"));

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

describe("NodeKernelManager native execution", () => {
  it.skipIf(!["linux", "darwin"].includes(process.platform))("retires a real sandbox process group after its leader exits and retries failed verification", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kernel-orphan-retirement-")); cleanup.push(cwd);
    vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "private"));
    const { saveSessionApproval, readSessionApproval } = await import("../sandbox/session-approval.js");
    const { AgentCoreSessionService } = await import("../agent/agent-core-session-service.js");
    const { workspaceIdentity } = await import("../agent/workspace-session-identity.js");
    await saveSessionApproval(cwd, "owner", "full", 0);
    let leader: ChildProcess | undefined;
    // Exercise real POSIX process lifetime independently of sandbox installation:
    // the bridge stand-in leaves an ordinary background descendant on normal exit.
    const bridge = `const {spawn}=require('node:child_process');
      const background=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); background.unref();
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line); console.log(JSON.stringify({id:request.id,type:'result',ok:true,stdout:String(background.pid),stderr:'',interrupted:false}));
      }).on('close',()=>process.exit(0));`;
    const manager = new NodeKernelManager({ interpreterAvailable: () => true,
      spawnProcess: ((_command: string, _args: readonly string[], options: SpawnOptions) =>
        (leader = spawn(process.execPath, ["-e", bridge], { ...options, detached: true }))) as typeof spawn });
    const cleanupSandbox = vi.fn(async () => undefined);
    const verification = vi.spyOn(sandboxProcesses, "retireSandboxGroup").mockRejectedValue(new Error("group verification failed"));
    let descendant = 0;
    try {
      const result = await manager.execute({ language: "python", cwd, environment: status(cwd, cwd), code: "1+1", timeoutMs: 5_000,
        sandboxPolicy: await sandboxPolicies.workspacePolicy(cwd, undefined, "analysis", "owner") });
      descendant = Number(result.stdout);
      const internals = manager as unknown as { sessions: Map<string, { sandbox?: { cleanup(): Promise<void> }; child?: ChildProcess; stopPromise?: Promise<void> }> };
      const session = [...internals.sessions.values()][0]!;
      session.sandbox = { cleanup: cleanupSandbox };
      const exited = new Promise<void>((resolve) => leader!.once("exit", () => resolve()));
      leader!.stdin!.end();
      await exited;
      await session.stopPromise?.catch(() => undefined);
      expect(leader!.exitCode).toBe(0);
      process.kill(descendant, 0); // The descendant really outlived the leader.
      const service = new AgentCoreSessionService({ expectExit: vi.fn(), publish: vi.fn(async () => undefined) } as never, {} as never, {
        hasApprovalResources: (workspace, owner) => manager.hasOwner(workspace, owner),
        revokeApprovalResources: (workspace, owner) => manager.revokeOwner(workspace, owner),
      });
      const runtime = { cwd, sessionId: "owner", isClosed: false, sendCommand: vi.fn(async () => ({ success: true, data: { busy: false, queues: [], operation: null } })) };
      (service as unknown as { live: Map<string, unknown> }).live.set(`${workspaceIdentity(cwd)}\0owner`, { key: "owner-worker", runtime, busy: false });
      expect(await service.setApprovalMode(cwd, "owner", "ask", 1)).toMatchObject({ success: false, code: "permission_transition_failed" });
      expect(await readSessionApproval(cwd, "owner")).toEqual({ mode: "full", revision: 1 });
      expect(session.child).toBe(leader);
      expect(manager.hasOwner(cwd, "owner")).toBe(true);
      expect(cleanupSandbox).not.toHaveBeenCalled();
      verification.mockRestore();
      expect(await service.setApprovalMode(cwd, "owner", "ask", 1)).toMatchObject({ success: true, data: { mode: "ask", revision: 2 } });
      const probe = spawnSync("/bin/ps", ["-p", String(descendant), "-o", "stat="], { encoding: "utf8" });
      expect(probe.error).toBeUndefined();
      expect([0, 1]).toContain(probe.status);
      expect(probe.stdout.trim() === "" || probe.stdout.trim().startsWith("Z")).toBe(true);
      expect(manager.hasOwner(cwd, "owner")).toBe(false);
      expect(cleanupSandbox).toHaveBeenCalledOnce();
    } finally {
      verification.mockRestore();
      if (leader?.pid) sandboxProcesses.killSandboxGroup(leader.pid);
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("preserves native loader settings without inheriting model credentials", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-env-")); cleanup.push(workspace);
    const prefix = join(workspace, "env"); await createTestEnvironment(prefix);
    vi.stubEnv("DEEPSEEK_API_KEY", "native-test-secret");
    const manager = new NodeKernelManager();
    try {
      const result = await manager.execute({ language: "python", cwd: workspace, environment: status(workspace, prefix), timeoutMs: 10_000,
        code: "import os\nassert 'DEEPSEEK_API_KEY' not in os.environ\nassert os.environ.get('PATH')\nif os.name == 'nt': assert os.environ.get('SystemRoot')\nprint('safe-native-environment')" });
      expect(result).toMatchObject({ ok: true, stdout: "safe-native-environment\n" });
    } finally { await manager.shutdownAll(); }
  });
  it.skipIf(python === null)("spawns the kernel bridge directly from the environment prefix and returns a cell result", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-kernel-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);

    const manager = new NodeKernelManager();
    try {
      const result = await manager.execute({
        language: "python",
        code: "1+1",
        cwd: workspace,
        environment: status(workspace, prefix),
        timeoutMs: 10_000,
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("");
      expect(result.result).toBe("2");
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("captures explicit display outputs in order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-kernel-display-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);

    const manager = new NodeKernelManager();
    try {
      const result = await manager.execute({
        language: "python",
        code: "display({'value': 1})\ndisplay('done')",
        cwd: workspace,
        environment: status(workspace, prefix),
        timeoutMs: 10_000,
      });
      expect(result.ok).toBe(true);
      expect(result.outputs).toMatchObject([
        { output_type: "display_data", data: { "application/json": '{"value": 1}', "text/plain": "{'value': 1}" } },
        { output_type: "display_data", data: { "text/plain": "'done'" } },
      ]);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null || !hasMatplotlib)("captures matplotlib figures when show is called", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-kernel-matplotlib-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);

    const manager = new NodeKernelManager();
    try {
      const result = await manager.execute({
        language: "python",
        code: "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nplt.plot([1, 2], [3, 4])\nplt.show()",
        cwd: workspace,
        environment: status(workspace, prefix),
        timeoutMs: 30_000,
      });
      expect(result.ok).toBe(true);
      expect(result.outputs?.some((output) => Boolean(output.data["image/png"]))).toBe(true);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("preserves stdout and stderr as separate notebook streams", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-kernel-streams-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);

    const manager = new NodeKernelManager();
    try {
      const result = await manager.execute({
        language: "python",
        code: "import sys\nprint('stdout')\nprint('stderr', file=sys.stderr)",
        cwd: workspace,
        environment: status(workspace, prefix),
        timeoutMs: 10_000,
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("stdout\n");
      expect(result.stderr).toBe("stderr\n");
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("preserves namespace across cells in one session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-kernel-state-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);

    const manager = new NodeKernelManager();
    try {
      await manager.execute({ language: "python", code: "x = 40", cwd: workspace, environment: status(workspace, prefix), timeoutMs: 10_000 });
      const second = await manager.execute({ language: "python", code: "x + 2", cwd: workspace, environment: status(workspace, prefix), timeoutMs: 10_000 });
      expect(second.ok).toBe(true);
      expect(second.result).toBe("42");
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("imports workspace-local Python modules", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-kernel-imports-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);
    await writeFile(join(workspace, "local_module.py"), "value = 41\n", "utf8");

    const manager = new NodeKernelManager();
    try {
      const result = await manager.execute({
        language: "python",
        code: "import local_module\nlocal_module.value + 1",
        cwd: workspace,
        environment: status(workspace, prefix),
        timeoutMs: 10_000,
      });
      expect(result.ok).toBe(true);
      expect(result.result).toBe("42");
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("reports active sessions and shuts a notebook down natively", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-kernel-shutdown-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);

    const manager = new NodeKernelManager();
    try {
      await manager.execute({ language: "python", code: "1+1", cwd: workspace, environment: status(workspace, prefix), notebookId: "nb-1", timeoutMs: 10_000 });
      const before = manager.status();
      expect(before.native).toBe(true);
      expect(before.active_count).toBe(1);
      expect(manager.activeCount).toBe(1);
      expect(before.sessions).toEqual([expect.objectContaining({ notebookId: "nb-1", language: "python", cwd: workspace })]);

      await manager.shutdownNotebook("nb-1", workspace);
      expect(manager.status().active_count).toBe(0);
      expect(manager.activeCount).toBe(0);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("deduplicates a concurrent cold start into one kernel session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-kernel-race-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);

    const manager = new NodeKernelManager();
    try {
      const options = { language: "python" as const, cwd: workspace, environment: status(workspace, prefix), notebookId: "nb-race", timeoutMs: 10_000 };
      const [first, second] = await Promise.all([
        manager.execute({ ...options, code: "x = 40" }),
        manager.execute({ ...options, code: "x + 2" }),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.result).toBe("42");
      expect(manager.status().active_count).toBe(1);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("preserves admission order while the first policy is delayed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-policy-order-")); cleanup.push(workspace);
    const prefix = join(workspace, "env"); await createTestEnvironment(prefix);
    const original = sandboxPolicies.workspacePolicy;
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const policy = vi.spyOn(sandboxPolicies, "workspacePolicy").mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args); });
    const manager = new NodeKernelManager();
    const options = { language: "python" as const, cwd: workspace, environment: status(workspace, prefix), notebookId: "ordered", timeoutMs: 10_000 };
    const first = manager.execute({ ...options, code: "ordered_value = 40" });
    const second = manager.execute({ ...options, code: "ordered_value + 2" });
    // Attach rejection handlers before making assertions that can fail.
    const results = Promise.allSettled([first, second]);
    try {
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(policy).toHaveBeenCalledTimes(1);
      release();
      expect(await first).toMatchObject({ ok: true });
      expect(await second).toMatchObject({ ok: true, result: "42" });
      expect(manager.status().active_count).toBe(1);
    } finally { release(); await results; await manager.shutdownAll(); }
  });

  it.skipIf(python === null)("handles cell timeouts without leaking the manager state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-native-kernel-timeout-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);

    const manager = new NodeKernelManager();
    try {
      const outcome = await manager.execute({ language: "python", code: "import time\ntime.sleep(5)", cwd: workspace, environment: status(workspace, prefix), notebookId: "nb-timeout", timeoutMs: 500 }).then(
        (value) => ({ resolved: true as const, value }),
        (error: Error) => ({ resolved: false as const, error }),
      );
      if (outcome.resolved) {
        // POSIX: SIGINT succeeded, the bridge reported the interrupt and the namespace survives.
        expect(outcome.value.ok).toBe(false);
        expect(outcome.value.interrupted).toBe(true);
        expect(manager.status().active_count).toBe(1);
      } else {
        // Windows or a failed interrupt: the session is torn down instead of leaking.
        expect(outcome.error.message).toMatch(/timed out|interrupt/i);
        expect(manager.status().active_count).toBe(0);
      }
    } finally {
      await manager.shutdownAll();
    }
  });

});

describe("NodeKernelManager platform interrupt semantics", () => {
  interface FakeSession { child: ChildProcess; writes: string[]; kills: (string | number)[]; answered: Set<string> }
  function fakeChild(): FakeSession {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    const writes: string[] = [];
    stdin.on("data", (chunk: Buffer) => writes.push(String(chunk)));
    const kills: (string | number)[] = [];
    (child as unknown as Record<string, unknown>).stdin = stdin;
    (child as unknown as Record<string, unknown>).stdout = new PassThrough();
    (child as unknown as Record<string, unknown>).stderr = new PassThrough();
    (child as unknown as Record<string, unknown>).pid = 4242;
    (child as unknown as Record<string, unknown>).exitCode = null;
    (child as unknown as Record<string, unknown>).kill = ((signal?: string | number) => { kills.push(signal ?? "SIGTERM"); return true; }) as ChildProcess["kill"];
    return { child, writes, kills, answered: new Set<string>() };
  }

  function managerWithFake(platform: NodeJS.Platform) {
    const spawned: { command: string; args: string[]; options?: SpawnOptions }[] = [];
    const treeKills: number[] = [];
    const sessions: FakeSession[] = [];
    const killTree = vi.fn((pid: number) => { treeKills.push(pid); });
    const manager = new NodeKernelManager({
      platform,
      workspaceEnvironmentVariables: () => ({}),
      interpreterAvailable: () => true,
      spawnProcess: ((command: string, args: readonly string[], options?: SpawnOptions) => {
        spawned.push({ command, args: [...args], options });
        const session = fakeChild();
        sessions.push(session);
        return session.child;
      }) as unknown as typeof import("node:child_process").spawn,
      killProcessTree: killTree,
    });
    return { manager, spawned, treeKills, sessions, killTree };
  }

  /** Answers every bridge request that has not been responded to yet. */
  function respondPending(session: FakeSession, overrides: Partial<KernelResult> = {}): void {
    for (const line of session.writes) {
      const request = JSON.parse(line) as { id: string };
      if (session.answered.has(request.id)) continue;
      session.answered.add(request.id);
      (session.child.stdout as PassThrough).write(`${JSON.stringify({ id: request.id, type: "result", ok: true, stdout: "", stderr: "", result: "2", error: null, interrupted: false, ...overrides })}\n`);
    }
  }

  async function waitForRequest(sessions: FakeSession[], count: number): Promise<void> {
    await vi.waitFor(() => { expect(sessions.length).toBeGreaterThan(0); expect(sessions[0]!.writes.length).toBeGreaterThanOrEqual(count); });
  }

  /** Runs a cell to completion: answers the health probe, then the cell itself. */
  async function driveExecute(manager: NodeKernelManager, sessions: FakeSession[], cwd: string, env: WorkspaceEnvironmentStatus, code: string, extra: Partial<KernelExecuteOptions> = {}): Promise<KernelResult> {
    const result = manager.execute({ language: "python", code, cwd, environment: env, kernelInstanceId: "k-interrupt", timeoutMs: 30_000, ...extra });
    await waitForRequest(sessions, 1);
    respondPending(sessions[0]!);
    await waitForRequest(sessions, 2);
    respondPending(sessions[0]!);
    return result;
  }

  it("falls back to prefix-root python.exe on Windows when Scripts is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-win32-python-root-"));
    cleanup.push(cwd);
    const prefix = join(cwd, "env");
    await mkdir(prefix, { recursive: true });
    const python = join(prefix, "python.exe");
    await writeFile(python, "", "utf8");
    const { manager, spawned, sessions } = managerWithFake("win32");
    try {
      const result = await driveExecute(manager, sessions, cwd, status(cwd, prefix), "1+1");
      expect(result.ok).toBe(true);
      expect(spawned[0]?.command).toBe(python);
    } finally {
      const stopping = manager.shutdownAll().catch(() => undefined);
      for (const session of sessions) session.child.emit("close", 0);
      await stopping;
    }
  });

  it("cancels a cold start before shutdownAll returns", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-kernel-start-shutdown-all-"));
    cleanup.push(cwd);
    const { manager, sessions } = managerWithFake("linux");
    const env = status(cwd, join(cwd, "env"));
    const execution = manager.execute({ language: "python", code: "1+1", cwd, environment: env, notebookId: "nb-starting", timeoutMs: 30_000 }).then(
      (value) => ({ resolved: true as const, value }),
      (error: Error) => ({ resolved: false as const, error }),
    );
    try {
      await waitForRequest(sessions, 1);
      const shutdown = manager.shutdownAll();
      await vi.waitFor(() => expect(sessions[0]!.kills).toContain("SIGTERM"));
      await expect(manager.execute({ language: "python", code: "2+2", cwd, environment: env, notebookId: "nb-late", timeoutMs: 30_000 })).rejects.toThrow("Kernel shutdown is in progress");
      sessions[0]!.child.emit("close", 0);
      await shutdown;

      const outcome = await execution;
      expect(outcome.resolved).toBe(false);
      if (!outcome.resolved) expect(outcome.error.message).toContain("cancelled by shutdown");
      expect(manager.status().active_count).toBe(0);
    } finally {
      const stopping = manager.shutdownAll().catch(() => undefined);
      for (const session of sessions) session.child.emit("close", 0);
      await stopping;
    }
  });

  it("cancels only the matching cold start during shutdownNotebook", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-kernel-start-shutdown-notebook-"));
    cleanup.push(cwd);
    const { manager, sessions } = managerWithFake("linux");
    const env = status(cwd, join(cwd, "env"));
    const target = manager.execute({ language: "python", code: "1+1", cwd, environment: env, notebookId: "nb-target", timeoutMs: 30_000 }).then(
      (value) => ({ resolved: true as const, value }),
      (error: Error) => ({ resolved: false as const, error }),
    );
    try {
      // Both starts remain pending, but filesystem scheduling must not decide
      // which fake child the cancellation assertions identify as the target.
      await waitForRequest(sessions, 1);
      const survivor = manager.execute({ language: "python", code: "2+2", cwd, environment: env, notebookId: "nb-survivor", timeoutMs: 30_000 }).then(
        (value) => ({ resolved: true as const, value }),
        (error: Error) => ({ resolved: false as const, error }),
      );
      await vi.waitFor(() => { expect(sessions).toHaveLength(2); expect(sessions.every((session) => session.writes.length >= 1)).toBe(true); });
      const shutdown = manager.shutdownNotebook("nb-target", cwd);
      await vi.waitFor(() => expect(sessions[0]!.kills).toContain("SIGTERM"));
      expect(sessions[1]!.kills).toEqual([]);
      await expect(manager.execute({ language: "python", code: "3+3", cwd, environment: env, notebookId: "nb-target", timeoutMs: 30_000 })).rejects.toThrow("Kernel shutdown is in progress");
      sessions[0]!.child.emit("close", 0);
      await shutdown;

      const targetOutcome = await target;
      expect(targetOutcome.resolved).toBe(false);
      if (!targetOutcome.resolved) expect(targetOutcome.error.message).toContain("cancelled by shutdown");
      respondPending(sessions[1]!);
      await waitForRequest([sessions[1]!], 2);
      respondPending(sessions[1]!);
      const survivorOutcome = await survivor;
      expect(survivorOutcome.resolved).toBe(true);
      if (survivorOutcome.resolved) expect(survivorOutcome.value.ok).toBe(true);
      expect(manager.status().active_count).toBe(1);
    } finally {
      const stopping = manager.shutdownAll().catch(() => undefined);
      for (const session of sessions) session.child.emit("close", 0);
      await stopping;
    }
  });

  it("spawns detached on windows and interrupts a running cell with SIGBREAK", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-win32-interrupt-"));
    cleanup.push(cwd);
    const { manager, spawned, treeKills, sessions } = managerWithFake("win32");
    const env = status(cwd, join(cwd, "env"));
    try {
      const first = await driveExecute(manager, sessions, cwd, env, "1+1");
      expect(first.ok).toBe(true);
      expect(spawned[0]?.options).toMatchObject({ detached: true });

      const second = manager.execute({ language: "python", code: "import time\ntime.sleep(30)", cwd, environment: env, kernelInstanceId: "k-interrupt", timeoutMs: 30_000 });
      await waitForRequest(sessions, 3);
      expect(await manager.interruptNotebook("k-interrupt", cwd)).toBe(true);
      expect(sessions[0]!.kills).toContain("SIGBREAK");
      respondPending(sessions[0]!, { ok: false, result: null, error: "KeyboardInterrupt", interrupted: true });
      const result = await second;
      expect(result.interrupted).toBe(true);
    } finally {
      const stopping = manager.shutdownAll().catch(() => undefined);
      for (const session of sessions) session.child.emit("close", 0);
      await stopping;
    }
    expect(treeKills).toContain(4242);
  });

  it("keeps posix spawns attached and signals SIGINT", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-posix-interrupt-"));
    cleanup.push(cwd);
    const { manager, spawned, treeKills, sessions } = managerWithFake("linux");
    const env = status(cwd, join(cwd, "env"));
    try {
      const first = await driveExecute(manager, sessions, cwd, env, "1+1");
      expect(first.ok).toBe(true);
      expect(spawned[0]?.options?.detached).toBeUndefined();

      const second = manager.execute({ language: "python", code: "import time\ntime.sleep(30)", cwd, environment: env, kernelInstanceId: "k-interrupt", timeoutMs: 30_000 });
      await waitForRequest(sessions, 3);
      expect(await manager.interruptNotebook("k-interrupt", cwd)).toBe(true);
      expect(sessions[0]!.kills).toContain("SIGINT");
      respondPending(sessions[0]!, { ok: false, result: null, error: "KeyboardInterrupt", interrupted: true });
      expect((await second).interrupted).toBe(true);
    } finally {
      const stopping = manager.shutdownAll().catch(() => undefined);
      for (const session of sessions) session.child.emit("close", 0);
      await stopping;
    }
    expect(treeKills).toEqual([]);
  });

  it("retries the real kernel stop after process exit succeeded but sandbox cleanup failed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kernel-cleanup-retry-")); cleanup.push(cwd);
    const { manager, sessions, killTree } = managerWithFake("win32");
    const policy = sandboxPolicies.identifyPolicy({ ...await sandboxPolicies.workspacePolicy(cwd), owner: "owner" });
    const cleanupSandbox = vi.fn().mockRejectedValueOnce(new Error("sandbox cleanup failed")).mockResolvedValue(undefined);
    try {
      await driveExecute(manager, sessions, cwd, status(cwd, join(cwd, "env")), "1+1", { sandboxPolicy: policy });
      const internals = manager as unknown as { sessions: Map<string, { sandbox?: { cleanup(): Promise<void> }; child?: ChildProcess }> };
      const session = [...internals.sessions.values()][0]!;
      // The actual NodeKernelSession.stop implementation runs against an
      // isolated fake Windows child; no host process is signalled.
      session.sandbox = { cleanup: cleanupSandbox };
      const failed = manager.revokeOwner(cwd, "owner").catch((error: Error) => error);
      await vi.waitFor(() => expect(killTree).toHaveBeenCalledOnce());
      sessions[0]!.child.emit("close", 0);
      expect(await failed).toMatchObject({ message: "sandbox cleanup failed" });
      expect(session.child).toBeUndefined(); // Exit was verified before cleanup.
      expect(manager.hasOwner(cwd, "owner")).toBe(true);
      expect(await manager.revokeOwner(cwd, "owner")).toEqual({ kernelRestartCount: 1 });
      expect(cleanupSandbox).toHaveBeenCalledTimes(2);
      expect(killTree).toHaveBeenCalledOnce(); // Cleanup retry does not kill again.
      expect(manager.hasOwner(cwd, "owner")).toBe(false);
    } finally {
      cleanupSandbox.mockResolvedValue(undefined);
      for (const session of sessions) session.child.emit("close", 0);
      await manager.shutdownAll();
    }
  });

  it("keeps full → ask blocked after reauthorization and process-stop failures until verified recovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kernel-reauthorization-retirement-")); cleanup.push(cwd);
    const home = await mkdtemp(join(tmpdir(), "kernel-reauthorization-private-")); cleanup.push(home); vi.stubEnv("PI_SCIENCE_HOME", home);
    const { saveSessionApproval, readSessionApproval } = await import("../sandbox/session-approval.js");
    const { AgentCoreSessionService } = await import("../agent/agent-core-session-service.js");
    const { workspaceIdentity } = await import("../agent/workspace-session-identity.js");
    await saveSessionApproval(cwd, "owner", "full", 0);
    const full = await sandboxPolicies.workspacePolicy(cwd, undefined, "analysis", "owner");
    const { manager, sessions, spawned, killTree } = managerWithFake("win32");
    try {
      const environment = status(cwd, join(cwd, "env"));
      await driveExecute(manager, sessions, cwd, environment, "1+1", { sandboxPolicy: full });
      killTree.mockImplementation(() => { throw new Error("process exit unconfirmed"); });
      const authorize = vi.fn().mockResolvedValueOnce(full).mockRejectedValueOnce(new Error("authorization revoked"));
      await expect(manager.execute({ language: "python", cwd, environment, kernelInstanceId: "k-interrupt", timeoutMs: 30_000,
        sandboxPolicy: full, authorize, code: "must-not-run" })).rejects.toThrow("retirement is incomplete");
      expect(sessions[0]!.writes).toHaveLength(2); // Health check + first cell only.
      expect(manager.hasOwner(cwd, "owner")).toBe(true);
      const owned = manager as unknown as { sessions: Map<string, { child?: ChildProcess }> };
      expect([...owned.sessions.values()][0]!.child).toBe(sessions[0]!.child);
      const events = { expectExit: vi.fn(), publish: vi.fn(async () => undefined) };
      const service = new AgentCoreSessionService(events as never, {} as never, {
        hasApprovalResources: (workspace, owner) => manager.hasOwner(workspace, owner),
        revokeApprovalResources: (workspace, owner) => manager.revokeOwner(workspace, owner),
      });
      const runtime = { cwd, sessionId: "owner", isClosed: false, sendCommand: vi.fn(async () => ({ success: true, data: { busy: false, queues: [], operation: null } })) };
      (service as unknown as { live: Map<string, unknown> }).live.set(`${workspaceIdentity(cwd)}\0owner`, { key: "owner-worker", runtime, busy: false });
      expect(await service.setApprovalMode(cwd, "owner", "ask", 1)).toMatchObject({ success: false, code: "permission_transition_failed" });
      expect(await readSessionApproval(cwd, "owner")).toEqual({ mode: "full", revision: 1 });
      expect(service.approvalTransitionPending(cwd, "owner")).toBe(true);
      await expect(manager.execute({ language: "python", cwd, environment, kernelInstanceId: "k-interrupt", timeoutMs: 30_000,
        sandboxPolicy: full, code: "must-not-reuse" })).rejects.toThrow("process exit unconfirmed");
      expect(spawned).toHaveLength(1);
      killTree.mockImplementation(() => undefined);
      const previousKills = killTree.mock.calls.length;
      const retry = service.setApprovalMode(cwd, "owner", "ask", 1);
      await vi.waitFor(() => expect(killTree.mock.calls.length).toBeGreaterThan(previousKills));
      sessions[0]!.child.emit("close", 0);
      expect(await retry).toMatchObject({ success: true, data: { mode: "ask", revision: 2 } });
      expect(manager.hasOwner(cwd, "owner")).toBe(false);
      expect(service.approvalTransitionPending(cwd, "owner")).toBe(false);
    } finally {
      killTree.mockImplementation(() => undefined);
      for (const session of sessions) session.child.emit("close", 0);
      await manager.shutdownAll();
    }
  });

  it("spares an idle kernel from manual interrupts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-idle-interrupt-"));
    cleanup.push(cwd);
    const { manager, treeKills, sessions } = managerWithFake("win32");
    const env = status(cwd, join(cwd, "env"));
    try {
      await driveExecute(manager, sessions, cwd, env, "1+1");
      expect(await manager.interruptNotebook("k-interrupt", cwd)).toBe(false);
      expect(sessions[0]!.kills).toEqual([]);
    } finally {
      const stopping = manager.shutdownAll().catch(() => undefined);
      for (const session of sessions) session.child.emit("close", 0);
      await stopping;
    }
    expect(treeKills).toContain(4242);
  });

  it.skipIf(python === null || process.platform === "win32")("keeps the session usable after an interrupted cell", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-kernel-recover-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    await createTestEnvironment(prefix);

    const manager = new NodeKernelManager();
    try {
      await manager.execute({ language: "python", code: "x = 41", cwd: workspace, environment: status(workspace, prefix), notebookId: "nb-recover", timeoutMs: 8_000 });
      const outcome = await manager.execute({ language: "python", code: "import time\ntime.sleep(5)", cwd: workspace, environment: status(workspace, prefix), notebookId: "nb-recover", timeoutMs: 500 }).then(
        (value) => ({ resolved: true as const, value }),
        (error: Error) => ({ resolved: false as const, error }),
      );
      expect(outcome.resolved && outcome.value.interrupted).toBe(true);
      // The interrupted namespace survives; the queued follow-up cell runs normally.
      const followup = await manager.execute({ language: "python", code: "x + 1", cwd: workspace, environment: status(workspace, prefix), notebookId: "nb-recover", timeoutMs: 5_000 });
      expect(followup.ok).toBe(true);
      expect(followup.result).toBe("42");
      const snapshot = manager.status();
      expect(snapshot.active_count).toBe(1);
      expect(snapshot.sessions.every((session) => session.alive)).toBe(true);
    } finally {
      await manager.shutdownAll();
    }
  });

  // Real-boundary coverage for Windows: the fake-child tests above pin the
  // win32 spawn/detach/SIGBREAK semantics, and the Python bridge tests exercise
  // the identical stdio protocol on every platform.
  it.skipIf(rscript === null)("executes cells through the real R bridge with a persistent namespace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-r-bridge-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    const binDir = join(prefix, "bin");
    await mkdir(binDir, { recursive: true });
    await symlink(rscript!, join(binDir, "Rscript"));

    const manager = new NodeKernelManager();
    try {
      const first = await manager.execute({ language: "r", code: "answer <- 21", cwd: workspace, environment: status(workspace, prefix), notebookId: "nb-r", timeoutMs: 15_000 });
      expect(first.ok).toBe(true);
      const second = await manager.execute({ language: "r", code: "answer * 2", cwd: workspace, environment: status(workspace, prefix), notebookId: "nb-r", timeoutMs: 15_000 });
      expect(second.ok).toBe(true);
      expect(second.result).toBe("[1] 42");
    } finally {
      await manager.shutdownAll();
    }
    // Two real executions each have a 15s budget, plus startup and shutdown.
  }, 45_000);

});

it("does not forget an owner's kernel until permission revocation succeeds", async () => {
  const manager = new NodeKernelManager();
  const stop = vi.fn().mockRejectedValueOnce(new Error("process still alive")).mockResolvedValue(undefined);
  const session = { cwd: "/workspace", owner: "session-a", stop };
  const internals = manager as unknown as { sessions: Map<string, typeof session> };
  internals.sessions.set("kernel-a", session);
  expect(manager.hasOwner("/workspace", "session-a")).toBe(true);
  expect(manager.hasOwner("/workspace", "session-b")).toBe(false);
  await expect(manager.shutdownOwner("/workspace", "session-a")).rejects.toThrow("process still alive");
  expect(manager.hasOwner("/workspace", "session-a")).toBe(true);
  await manager.shutdownOwner("/workspace", "session-a");
  expect(manager.hasOwner("/workspace", "session-a")).toBe(false);
  expect(stop).toHaveBeenCalledTimes(2);
});

it.skipIf(python === null)("reauthorizes queued kernel work before any code is dispatched", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kernel-queued-epoch-")); cleanup.push(workspace);
  const prefix = join(workspace, "env"); await createTestEnvironment(prefix);
  const manager = new NodeKernelManager();
  const base = { language: "python" as const, cwd: workspace, environment: status(workspace, prefix), timeoutMs: 10_000, notebookId: "queue" };
  try {
    const first = manager.execute({ ...base, code: "import time; time.sleep(0.1); print('first')" });
    const authorize = vi.fn(async () => { throw new Error("approval revision revoked"); });
    const second = manager.execute({ ...base, code: "open('must-not-run', 'w').write('bad')", authorize });
    const denied = expect(second).rejects.toThrow("revision revoked");
    expect(await first).toMatchObject({ ok: true, stdout: "first\n" });
    await denied;
    const { access } = await import("node:fs/promises");
    await expect(access(join(workspace, "must-not-run"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(authorize).toHaveBeenCalledOnce();
  } finally { await manager.shutdownAll(); }
});
it.skipIf(python === null)("reclaims only the owner's old kernel namespace and reports its reset", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kernel-targeted-epoch-")); cleanup.push(workspace);
  const prefix = join(workspace, "env"); await createTestEnvironment(prefix);
  const manager = new NodeKernelManager();
  const policy = sandboxPolicies.identifyPolicy({ ...await sandboxPolicies.workspacePolicy(workspace), owner: "owner" });
  const base = { language: "python" as const, cwd: workspace, environment: status(workspace, prefix), timeoutMs: 10_000, notebookId: "targeted", sandboxPolicy: policy };
  try {
    await manager.execute({ ...base, code: "value=41" });
    expect(await manager.execute({ ...base, code: "value+1" })).toMatchObject({ ok: true, result: "42" });
    expect(await manager.revokeOwner(workspace, "other")).toEqual({ kernelRestartCount: 0 });
    expect(await manager.execute({ ...base, code: "value+1" })).toMatchObject({ ok: true, result: "42" });
    expect(await manager.revokeOwner(workspace, "owner")).toEqual({ kernelRestartCount: 1 });
    expect(manager.hasOwner(workspace, "owner")).toBe(false);
    expect(await manager.execute({ ...base, code: "print('value' in globals())" })).toMatchObject({ ok: true, stdout: "False\n" });
  } finally { await manager.shutdownAll(); }
});
