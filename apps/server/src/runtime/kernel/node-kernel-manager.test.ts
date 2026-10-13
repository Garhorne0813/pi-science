import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelProtocolError, NodeKernelManager, type KernelResult, type KernelStreamEvent } from "./node-kernel-manager.js";
import {
  boundKernelHeadText,
  boundKernelPayload,
  boundKernelText,
  DEFAULT_KERNEL_OUTPUT_LIMITS,
  KERNEL_TRUNCATION_MARKER,
  kernelOutputLimitArgs,
  kernelOutputLimits,
  kernelPayloadMarker,
  type KernelOutputLimits,
} from "./kernel-output-limits.js";
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

afterEach(async () => {
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

/**
 * Caps small enough that every bounded length and count stays readable in an
 * assertion. The 128 floor guards the environment, so a smaller cap is injected
 * as a literal object instead.
 */
function smallLimits(overrides: Partial<KernelOutputLimits> = {}): KernelOutputLimits {
  return { ...kernelOutputLimits({}), stdoutChars: 64, stderrChars: 64, resultChars: 64, mimeChars: 128, outputsChars: 1024, displayOutputs: 5, ...overrides };
}

async function pythonWorkspace(label: string): Promise<{ workspace: string; environment: WorkspaceEnvironmentStatus }> {
  const workspace = await mkdtemp(join(tmpdir(), `pi-science-kernel-${label}-`));
  cleanup.push(workspace);
  const prefix = join(workspace, "env");
  await createTestEnvironment(prefix);
  return { workspace, environment: status(workspace, prefix) };
}

describe("NodeKernelManager native execution", () => {
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
      expect(before.sessions).toEqual([expect.objectContaining({ notebookId: "nb-1", language: "python", cwd: workspace })]);

      await manager.shutdownNotebook("nb-1", workspace);
      expect(manager.status().active_count).toBe(0);
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
      killProcessTree: (pid: number) => { treeKills.push(pid); },
    });
    return { manager, spawned, treeKills, sessions };
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
  async function driveExecute(manager: NodeKernelManager, sessions: FakeSession[], cwd: string, env: WorkspaceEnvironmentStatus, code: string): Promise<KernelResult> {
    const result = manager.execute({ language: "python", code, cwd, environment: env, kernelInstanceId: "k-interrupt", timeoutMs: 30_000 });
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
    const survivor = manager.execute({ language: "python", code: "2+2", cwd, environment: env, notebookId: "nb-survivor", timeoutMs: 30_000 }).then(
      (value) => ({ resolved: true as const, value }),
      (error: Error) => ({ resolved: false as const, error }),
    );
    try {
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
  // the identical stdio protocol on every platform. A real Rscript start costs
  // more than the 5 s default budget for a whole test.
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
  }, 30_000);

});

describe("NodeKernelManager output limits", () => {
  it.skipIf(python === null)("bounds a multi-megabyte stdout and stderr and counts the dropped characters", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-streams");
    const manager = new NodeKernelManager({ limits: smallLimits({ stdoutChars: 256, stderrChars: 256 }) });
    try {
      const result = await manager.execute({
        language: "python",
        code: "import sys\nsys.stdout.write('x' * 10_000_000)\nsys.stderr.write('y' * 10_000_000)",
        cwd: workspace,
        environment,
        timeoutMs: 60_000,
      });
      expect(result.stdout.length).toBe(256);
      expect(result.stdout.startsWith("x".repeat(121))).toBe(true);
      expect(result.stdout.slice(121, 135)).toBe(KERNEL_TRUNCATION_MARKER);
      expect(result.stdout.endsWith("x".repeat(121))).toBe(true);
      expect(result.stderr.length).toBe(256);
      expect(result.stderr.slice(121, 135)).toBe(KERNEL_TRUNCATION_MARKER);
      expect(result.truncated).toEqual({ stdout_chars: 10_000_000 - 256, stderr_chars: 10_000_000 - 256 });
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("names a dropped payload in its own text-only notice output", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-notice");
    const manager = new NodeKernelManager({ limits: smallLimits({ mimeChars: 512 }) });
    try {
      const result = await manager.execute({
        language: "python",
        code: ["class Mixed:", "    def _repr_html_(self): return '<p>small</p>'", "    def _repr_png_(self): return b'\\x89PNG' + b'\\x00' * 3_000_000", "    def __repr__(self): return 'Mixed()'", "Mixed()"].join("\n"),
        cwd: workspace,
        environment,
        timeoutMs: 60_000,
      });
      const outputs = result.outputs ?? [];
      expect(result.mime).toEqual({ "text/html": "<p>small</p>" });
      expect(outputs[0]?.data["text/html"]).toBe("<p>small</p>");
      // One data key is what makes the notice render as text.
      expect(Object.keys(outputs[1]?.data ?? {})).toEqual(["text/plain"]);
      expect(outputs[1]?.data["text/plain"]?.endsWith(kernelPayloadMarker("image/png"))).toBe(true);
      expect(result.truncated?.rich_chars).toBe(4_000_008);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("clamps a multi-megabyte HTML payload to the mime cap", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-html");
    const manager = new NodeKernelManager({ limits: smallLimits() });
    try {
      const result = await manager.execute({
        language: "python",
        code: ["class Html:", "    def _repr_html_(self):", "        return '<p>' + 'h' * 5_000_000 + '</p>'", "Html()"].join("\n"),
        cwd: workspace,
        environment,
        timeoutMs: 60_000,
      });
      const html = result.mime["text/html"];
      expect(html?.length).toBe(128);
      expect(html?.startsWith("<p>")).toBe(true);
      expect(html?.slice(57, 71)).toBe(KERNEL_TRUNCATION_MARKER);
      expect(result.outputs?.[0]?.data["text/html"]?.length).toBe(128);
      expect(result.truncated?.rich_chars).toBe(5_000_007 - 128);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("drops a payload the cell's rich budget can no longer afford", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-rich-total");
    const manager = new NodeKernelManager({ limits: smallLimits({ mimeChars: 512, outputsChars: 600 }) });
    try {
      const result = await manager.execute({
        language: "python",
        code: [
          "class Html:",
          "    def __init__(self, n): self.n = n",
          "    def _repr_html_(self): return 'a' * self.n",
          "    def __repr__(self): return 'obj%d' % self.n",
          "display(Html(400))",
          "display(Html(400))",
        ].join("\n"),
        cwd: workspace,
        environment,
        timeoutMs: 60_000,
      });
      const outputs = result.outputs ?? [];
      expect(outputs).toHaveLength(3);
      expect(outputs[0]?.data["text/html"]).toBe("a".repeat(400));
      expect(outputs[1]?.data["text/html"]).toBeUndefined();
      expect(outputs[2]?.data).toEqual({ "text/plain": kernelPayloadMarker("text/html") });
      expect(result.truncated?.rich_chars).toBe(400);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("caps the display count and stands in one notice output", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-output-count");
    const manager = new NodeKernelManager({ limits: smallLimits({ mimeChars: 512 }) });
    try {
      const result = await manager.execute({
        language: "python",
        code: Array.from({ length: 25 }, (_value, index) => `display(${index})`).join("\n"),
        cwd: workspace,
        environment,
        timeoutMs: 60_000,
      });
      const outputs = result.outputs ?? [];
      expect(outputs.map((output) => output.data["text/plain"])).toEqual(["0", "1", "2", "3", KERNEL_TRUNCATION_MARKER.repeat(20)]);
      expect(result.truncated).toEqual({ outputs_dropped: 21 });
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("adds no notice when the display count sits exactly at the cap", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-output-exact");
    const manager = new NodeKernelManager({ limits: smallLimits() });
    try {
      const result = await manager.execute({
        language: "python",
        code: Array.from({ length: 5 }, (_value, index) => `display(${index})`).join("\n"),
        cwd: workspace,
        environment,
        timeoutMs: 60_000,
      });
      expect(result.outputs?.map((output) => output.data["text/plain"])).toEqual(["0", "1", "2", "3", "4"]);
      expect("truncated" in result).toBe(false);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("leaves a small cell untruncated", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-intact");
    const manager = new NodeKernelManager({ limits: smallLimits() });
    try {
      const result = await manager.execute({ language: "python", code: "1+1", cwd: workspace, environment, timeoutMs: 30_000 });
      expect(result.ok).toBe(true);
      expect(result.result).toBe("2");
      expect(result.stdout).toBe("");
      expect("truncated" in result).toBe(false);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null || process.platform === "win32")("keeps an interrupted cell's partial stdout without a truncation key", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-interrupt");
    const manager = new NodeKernelManager({ limits: smallLimits() });
    try {
      const outcome = await manager.execute({
        language: "python",
        code: "import sys\nimport time\nprint('before')\nsys.stdout.flush()\ntime.sleep(5)",
        cwd: workspace,
        environment,
        notebookId: "nb-limits-interrupt",
        timeoutMs: 700,
      }).then(
        (value) => ({ resolved: true as const, value }),
        (error: Error) => ({ resolved: false as const, error }),
      );
      expect(outcome.resolved).toBe(true);
      if (outcome.resolved) {
        expect(outcome.value.interrupted).toBe(true);
        expect(outcome.value.stdout).toBe("before\n");
        expect("truncated" in outcome.value).toBe(false);
      }
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("keeps a non-BMP and control-character line inside the frame guard", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-frame-guard");
    // The caps sit either side of the guard's 65,536 headroom: a smaller stderr cap
    // keeps the line under it and the guard never fires.
    const manager = new NodeKernelManager({ limits: kernelOutputLimits({ PI_SCIENCE_KERNEL_STDOUT_CHARS: "20000", PI_SCIENCE_KERNEL_STDERR_CHARS: "20000", PI_SCIENCE_KERNEL_RESULT_CHARS: "128", PI_SCIENCE_KERNEL_MIME_CHARS: "128", PI_SCIENCE_KERNEL_OUTPUTS_CHARS: "128" }) });
    try {
      const wide = await manager.execute({ language: "python", code: "import sys\nsys.stdout.write('\\U0001F600' * 100_000)", cwd: workspace, environment, timeoutMs: 30_000 });
      expect(wide.ok).toBe(true);
      // The bridge counts code points and Node counts UTF-16 code units, so Node clamps
      // the 20,000-character value again and drops a split surrogate pair at each end.
      expect(wide.stdout.length).toBe(19_998);
      expect(wide.stdout.startsWith("\u{1F600}".repeat(4_996))).toBe(true);
      expect(wide.stdout.slice(9_992, 10_006)).toBe(KERNEL_TRUNCATION_MARKER);
      expect(wide.stdout.endsWith("\u{1F600}".repeat(4_996))).toBe(true);
      // The bridge counts code points and the Node re-clamp counts UTF-16 code units, so
      // the merged total is 80,000 code points dropped by the bridge plus 19,988 units
      // dropped again by the clamp that split a surrogate pair.
      expect(wide.truncated).toEqual({ stdout_chars: 80_000 + 19_988 });

      const controls = await manager.execute({ language: "python", code: "import sys\nsys.stdout.write('\\U0001F600' * 100_000)\nsys.stderr.write('\\x01' * 25_000)\nraise ValueError('\\x01' * 25_000)", cwd: workspace, environment, timeoutMs: 30_000 });
      expect(controls.ok).toBe(false);
      expect(controls.interrupted).toBe(false);
      expect(controls.stderr.length).toBe(20_000);
      // The traceback prefix is the interpreter's, so only its bound is asserted here.
      expect(controls.error?.length).toBe(20_000);
      expect(controls.truncated?.stdout_chars).toBe(80_000 + 19_988);
      expect(controls.truncated?.stderr_chars ?? 0).toBeGreaterThan(25_000 - 20_000);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(python === null)("survives a lone surrogate in a cell's stdout", async () => {
    const { workspace, environment } = await pythonWorkspace("limits-surrogate");
    const manager = new NodeKernelManager({ limits: smallLimits() });
    try {
      const result = await manager.execute({ language: "python", code: "import sys\nsys.stdout.write('\\ud800' * 5)", cwd: workspace, environment, timeoutMs: 30_000 });
      // JSON cannot carry an unpaired surrogate, so the bridge replaces it on the wire
      // instead of failing the write and taking the kernel down with it.
      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("?????");
      expect(manager.status().active_count).toBe(1);
    } finally {
      await manager.shutdownAll();
    }
  });

  it.skipIf(rscript === null)("bounds R stdout and the printed tail expression", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-r-limits-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    const binDir = join(prefix, "bin");
    await mkdir(binDir, { recursive: true });
    await symlink(rscript!, join(binDir, "Rscript"));

    const manager = new NodeKernelManager({ limits: smallLimits({ stdoutChars: 256, stderrChars: 256, resultChars: 128 }) });
    const environment = status(workspace, prefix);
    try {
      const captured = await manager.execute({ language: "r", code: 'cat(strrep("x", 1000000))', cwd: workspace, environment, timeoutMs: 30_000 });
      expect(captured.stdout.length).toBe(256);
      expect(captured.stdout.startsWith("x".repeat(121))).toBe(true);
      expect(captured.stdout.slice(121, 135)).toBe(KERNEL_TRUNCATION_MARKER);
      expect(captured.truncated?.stdout_chars).toBe(1_000_000 - 256);

      // print() adds `[1] "` and a closing quote around the string.
      const printed = await manager.execute({ language: "r", code: 'strrep("q", 1000000)', cwd: workspace, environment, timeoutMs: 30_000 });
      expect(printed.result?.length).toBe(128);
      expect(printed.result?.startsWith('[1] "')).toBe(true);
      expect(printed.result?.endsWith(KERNEL_TRUNCATION_MARKER)).toBe(true);
      expect(printed.truncated?.result_chars).toBe(1_000_006 - 128);

      const intact = await manager.execute({ language: "r", code: "1+1", cwd: workspace, environment, timeoutMs: 30_000 });
      expect(intact.result).toBe("[1] 2");
      expect(intact.stdout).toBe("");
      expect("truncated" in intact).toBe(false);

      const failure = await manager.execute({ language: "r", code: 'stop(strrep("e", 100000))', cwd: workspace, environment, timeoutMs: 30_000 });
      expect(failure.ok).toBe(false);
      expect(failure.error?.length).toBe(256);
      expect(failure.error?.slice(121, 135)).toBe(KERNEL_TRUNCATION_MARKER);
      // R itself truncates the message buffer at 8,190 characters, so "Error: " plus
      // the message is 8,197 and the bridge bounds that at the 256-character cap.
      expect(failure.truncated?.stderr_chars).toBe(8_197 - 256);
    } finally {
      await manager.shutdownAll();
    }
  }, 30_000);
});

describe("NodeKernelManager output limits without an interpreter", () => {
  interface FakeKernel { child: ChildProcess; writes: string[]; kills: (string | number)[]; answered: Set<string> }

  function fakeKernel(): FakeKernel {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdin = new PassThrough();
    const writes: string[] = [];
    stdin.on("data", (chunk: Buffer) => writes.push(String(chunk)));
    const kills: (string | number)[] = [];
    (child as unknown as Record<string, unknown>).stdin = stdin;
    (child as unknown as Record<string, unknown>).stdout = new PassThrough();
    (child as unknown as Record<string, unknown>).stderr = new PassThrough();
    (child as unknown as Record<string, unknown>).pid = 5150;
    (child as unknown as Record<string, unknown>).exitCode = null;
    (child as unknown as Record<string, unknown>).kill = ((signal?: string | number) => { kills.push(signal ?? "SIGTERM"); return true; }) as ChildProcess["kill"];
    return { child, writes, kills, answered: new Set<string>() };
  }

  function fakeManager(limits: KernelOutputLimits) {
    const spawned: { command: string; args: string[] }[] = [];
    const kernels: FakeKernel[] = [];
    const manager = new NodeKernelManager({
      platform: "linux",
      workspaceEnvironmentVariables: () => ({}),
      interpreterAvailable: () => true,
      limits,
      spawnProcess: ((command: string, args: readonly string[]) => {
        spawned.push({ command, args: [...args] });
        const kernel = fakeKernel();
        kernels.push(kernel);
        return kernel.child;
      }) as unknown as typeof import("node:child_process").spawn,
    });
    return { manager, kernels, spawned };
  }

  /** Answers every bridge request that has not been responded to yet. */
  function respond(kernel: FakeKernel, overrides: Record<string, unknown> = {}): void {
    for (const line of kernel.writes) {
      const request = JSON.parse(line) as { id: string };
      if (kernel.answered.has(request.id)) continue;
      kernel.answered.add(request.id);
      (kernel.child.stdout as PassThrough).write(`${JSON.stringify({ id: request.id, type: "result", ok: true, stdout: "", stderr: "", result: null, error: null, interrupted: false, ...overrides })}\n`);
    }
  }

  /** Spawns through the fake, answers the health probe, and returns the cell's in-flight request. */
  interface KernelFakeRequest { kernel: FakeKernel; id: string }

  async function startCell(manager: NodeKernelManager, kernels: FakeKernel[], onEvent?: (event: KernelStreamEvent) => void): Promise<{ cell: KernelFakeRequest; result: Promise<KernelResult> }> {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-kernel-limits-fake-"));
    cleanup.push(cwd);
    const pending = manager.execute({ language: "python", code: "1+1", cwd, environment: status(cwd, join(cwd, "env")), kernelInstanceId: "k-limits", timeoutMs: 30_000, ...(onEvent ? { onEvent } : {}) });
    await vi.waitFor(() => expect(kernels[0]?.writes.length).toBeGreaterThanOrEqual(1));
    respond(kernels[0]!);
    await vi.waitFor(() => expect(kernels[0]!.writes.length).toBeGreaterThanOrEqual(2));
    return { cell: { kernel: kernels[0]!, id: (JSON.parse(kernels[0]!.writes.at(-1)!) as { id: string }).id }, result: pending };
  }

  async function stopFake(manager: NodeKernelManager, kernels: FakeKernel[]): Promise<void> {
    const stopping = manager.shutdownAll().catch(() => undefined);
    for (const kernel of kernels) kernel.child.emit("close", 0);
    await stopping;
  }

  it("clamps an over-budget result line to the injected caps", async () => {
    const { manager, kernels, spawned } = fakeManager(smallLimits({ stdoutChars: 64, resultChars: 64 }));
    try {
      const { cell, result } = await startCell(manager, kernels);
      expect(spawned[0]?.args[1]).toBe("--limits");
      expect(JSON.parse(spawned[0]!.args[2]!)).toEqual({ stdout_chars: 64, stderr_chars: 64, result_chars: 64, mime_chars: 128, outputs_chars: 1024, display_outputs: 5 });
      respond(cell.kernel, { stdout: "x".repeat(1000), result: "y".repeat(1000) });
      const value = await result;
      expect(value.stdout.length).toBe(64);
      expect(value.stdout.slice(25, 39)).toBe(KERNEL_TRUNCATION_MARKER);
      expect(value.result?.length).toBe(64);
      expect(value.result?.slice(50, 64)).toBe(KERNEL_TRUNCATION_MARKER);
      expect(value.truncated).toEqual({ stdout_chars: 1000 - 64, result_chars: 1000 - 64 });
    } finally {
      await stopFake(manager, kernels);
    }
  });

  it("degrades a report that carries no counts", async () => {
    const { manager, kernels } = fakeManager(smallLimits());
    try {
      const { cell, result } = await startCell(manager, kernels);
      respond(cell.kernel, { stdout: "small", truncated: { stdout_chars: -5, rich_chars: "lots" } });
      const value = await result;
      expect(value.stdout).toBe("small");
      expect(value.truncated).toBeUndefined();
    } finally {
      await stopFake(manager, kernels);
    }
  });

  it("drops an over-cap payload into its own text-only notice output", async () => {
    const { manager, kernels } = fakeManager(smallLimits());
    try {
      const { cell, result } = await startCell(manager, kernels);
      respond(cell.kernel, { mime: { "text/html": "<p>small</p>", "image/png": "A".repeat(4096) } });
      const value = await result;
      expect(value.mime).toEqual({ "text/html": "<p>small</p>" });
      expect(value.outputs).toEqual([{ output_type: "display_data", data: { "text/plain": kernelPayloadMarker("image/png") } }]);
      expect(value.truncated).toEqual({ rich_chars: 4096 });
    } finally {
      await stopFake(manager, kernels);
    }
  });

  it("delivers four payloads and one notice when the display count is over cap", async () => {
    const { manager, kernels } = fakeManager(smallLimits());
    try {
      const { cell, result } = await startCell(manager, kernels);
      respond(cell.kernel, { outputs: Array.from({ length: 25 }, (_value, index) => ({ output_type: "display_data", data: { "text/plain": String(index) } })) });
      const value = await result;
      expect(value.outputs?.map((output) => output.data["text/plain"])).toEqual(["0", "1", "2", "3", KERNEL_TRUNCATION_MARKER.repeat(20)]);
      expect(value.truncated).toEqual({ outputs_dropped: 21 });
    } finally {
      await stopFake(manager, kernels);
    }
  });

  it("adds no notice when the display count sits exactly at the cap", async () => {
    const { manager, kernels } = fakeManager(smallLimits());
    try {
      const { cell, result } = await startCell(manager, kernels);
      respond(cell.kernel, { outputs: Array.from({ length: 5 }, (_value, index) => ({ output_type: "display_data", data: { "text/plain": String(index) } })) });
      const value = await result;
      expect(value.outputs?.map((output) => output.data["text/plain"])).toEqual(["0", "1", "2", "3", "4"]);
      expect(value.truncated).toBeUndefined();
    } finally {
      await stopFake(manager, kernels);
    }
  });

  it("fails the cell and kills the child when a line exceeds the frame guard", async () => {
    const { manager, kernels } = fakeManager({ ...smallLimits(), frameChars: 4096 });
    try {
      const { cell, result } = await startCell(manager, kernels);
      // The killed child has to close for the manager's stop() to settle.
      const closed = vi.waitFor(() => expect(cell.kernel.kills).toContain("SIGTERM")).then(() => { cell.kernel.child.emit("close", 0); });
      (cell.kernel.child.stdout as PassThrough).write(`${JSON.stringify({ id: cell.id, type: "stream", stream: "stdout", text: "z".repeat(5000) })}\n`);
      const failure = await result.then(() => null, (error: Error) => error);
      await closed;
      expect(failure).toBeInstanceOf(KernelProtocolError);
      expect(failure?.message).toBe("Kernel protocol line exceeded 4096 characters");
      expect(cell.kernel.kills).toContain("SIGTERM");
      expect(manager.status().active_count).toBe(0);
    } finally {
      await stopFake(manager, kernels);
    }
  });

  it("stops forwarding a stream channel once its budget is spent", async () => {
    const { manager, kernels } = fakeManager(smallLimits({ stdoutChars: 64 }));
    const events: KernelStreamEvent[] = [];
    try {
      const { cell, result } = await startCell(manager, kernels, (event) => events.push(event));
      const stdout = cell.kernel.child.stdout as PassThrough;
      stdout.write(`${JSON.stringify({ id: cell.id, type: "stream", stream: "stdout", text: "x".repeat(100) })}\n`);
      stdout.write(`${JSON.stringify({ id: cell.id, type: "stream", stream: "stdout", text: "x".repeat(100) })}\n`);
      await vi.waitFor(() => expect(events.length).toBe(2));
      respond(cell.kernel);
      const value = await result;
      expect(events.map((event) => event.text)).toEqual(["x".repeat(64), KERNEL_TRUNCATION_MARKER]);
      // A stream drop is not a payload the cell failed to deliver, so it adds no count.
      expect(value.truncated).toBeUndefined();
    } finally {
      await stopFake(manager, kernels);
    }
  });
});

describe("kernel output limits", () => {
  it("defaults every cap and derives the frame guard from them", () => {
    expect(kernelOutputLimits({})).toEqual({
      stdoutChars: 65_536,
      stderrChars: 65_536,
      resultChars: 262_144,
      mimeChars: 1_048_576,
      outputsChars: 2_097_152,
      displayOutputs: 20,
      frameChars: 21_692_416,
    });
  });

  it("reads each cap from the environment", () => {
    const limits = kernelOutputLimits({
      PI_SCIENCE_KERNEL_STDOUT_CHARS: "128",
      PI_SCIENCE_KERNEL_STDERR_CHARS: "129",
      PI_SCIENCE_KERNEL_RESULT_CHARS: "130",
      PI_SCIENCE_KERNEL_MIME_CHARS: "131",
      PI_SCIENCE_KERNEL_OUTPUTS_CHARS: "132",
    });
    expect(limits).toMatchObject({ stdoutChars: 128, stderrChars: 129, resultChars: 130, mimeChars: 131, outputsChars: 132 });
    expect(limits.frameChars).toBe(6 * (128 + 2 * 129 + 130 + 131 + 132) + 65_536);
  });

  it("ignores a configured cap below the marker floor", () => {
    expect(kernelOutputLimits({ PI_SCIENCE_KERNEL_STDOUT_CHARS: "8" }).stdoutChars).toBe(DEFAULT_KERNEL_OUTPUT_LIMITS.stdoutChars);
    expect(kernelOutputLimits({ PI_SCIENCE_KERNEL_STDOUT_CHARS: "127" }).stdoutChars).toBe(DEFAULT_KERNEL_OUTPUT_LIMITS.stdoutChars);
    expect(kernelOutputLimits({ PI_SCIENCE_KERNEL_STDOUT_CHARS: "128" }).stdoutChars).toBe(128);
  });

  it("keeps the default for a value that is not a positive integer", () => {
    const limits = kernelOutputLimits({
      PI_SCIENCE_KERNEL_STDOUT_CHARS: "0",
      PI_SCIENCE_KERNEL_STDERR_CHARS: "-3",
      PI_SCIENCE_KERNEL_RESULT_CHARS: "many",
      PI_SCIENCE_KERNEL_MIME_CHARS: "1.5",
      PI_SCIENCE_KERNEL_OUTPUTS_CHARS: "",
    });
    expect(limits).toEqual(kernelOutputLimits({}));
  });

  it("recomputes the frame guard when a cap rises", () => {
    expect(kernelOutputLimits({ PI_SCIENCE_KERNEL_RESULT_CHARS: "4000000" }).frameChars).toBe(6 * (65_536 + 2 * 65_536 + 4_000_000 + 1_048_576 + 2_097_152) + 65_536);
  });

  it("counts the error channel, and five kinds of character, in the frame guard", () => {
    const limits = kernelOutputLimits({ PI_SCIENCE_KERNEL_STDOUT_CHARS: "128", PI_SCIENCE_KERNEL_STDERR_CHARS: "20000", PI_SCIENCE_KERNEL_RESULT_CHARS: "128", PI_SCIENCE_KERNEL_MIME_CHARS: "128", PI_SCIENCE_KERNEL_OUTPUTS_CHARS: "128" });
    // stdout + stderr + error + result + mime + outputs, each bounded at its cap and
    // worst-case escaped to six characters per character: a compliant line can reach this.
    expect(limits.frameChars).toBeGreaterThanOrEqual(6 * (limits.stdoutChars + limits.stderrChars + limits.stderrChars + limits.resultChars + limits.mimeChars + limits.outputsChars));
  });

  it("passes the caps to a bridge as parseable argv JSON", () => {
    const args = kernelOutputLimitArgs(kernelOutputLimits({ PI_SCIENCE_KERNEL_MIME_CHARS: "177" }));
    expect(args[0]).toBe("--limits");
    expect(JSON.parse(args[1]!)).toMatchObject({ mime_chars: 177, stdout_chars: 65_536, display_outputs: 20 });
  });

  it("keeps a worst-case result line inside the derived frame guard", () => {
    // C0 control characters escape to six characters and raw non-BMP characters are two
    // UTF-16 code units, at every cap at once.
    const limits = kernelOutputLimits({ PI_SCIENCE_KERNEL_STDOUT_CHARS: "20000", PI_SCIENCE_KERNEL_STDERR_CHARS: "20000", PI_SCIENCE_KERNEL_RESULT_CHARS: "128", PI_SCIENCE_KERNEL_MIME_CHARS: "128", PI_SCIENCE_KERNEL_OUTPUTS_CHARS: "128" });
    const line = JSON.stringify({
      id: "0".repeat(36),
      type: "result",
      ok: true,
      stdout: "\u0001".repeat(20_000),
      stderr: "\u0001".repeat(20_000),
      error: "\u0001".repeat(20_000),
      result: "\u{1F600}".repeat(128),
      mime: { "text/html": "\u0001".repeat(128) },
      outputs: [{ output_type: "display_data", data: { "text/html": "\u0001".repeat(128) } }],
    });
    expect(line.length).toBeLessThanOrEqual(limits.frameChars);
    // The derivation before this fix omitted the error channel, so it rejected this line.
    expect(line.length).toBeGreaterThan(6 * (limits.stdoutChars + limits.stderrChars + limits.resultChars + limits.mimeChars + limits.outputsChars) + 65_536);
  });

  it("never leaves an unpaired surrogate when it clamps a non-BMP value", () => {
    const paired = (text: string): boolean => {
      for (let index = 0; index < text.length; index += 1) {
        const unit = text.charCodeAt(index);
        const previous = text.charCodeAt(index - 1);
        const next = text.charCodeAt(index + 1);
        if (unit >= 0xd800 && unit <= 0xdbff && !(next >= 0xdc00 && next <= 0xdfff)) return false;
        if (unit >= 0xdc00 && unit <= 0xdfff && !(previous >= 0xd800 && previous <= 0xdbff)) return false;
      }
      return true;
    };
    for (const cap of [128, 65, 64, 63, 20, 17, 15, 14, 8, 1]) {
      for (const clamped of [boundKernelText("\u{1F600}".repeat(64), cap), boundKernelHeadText("\u{1F600}".repeat(64), cap)]) {
        expect(clamped.length).toBeLessThanOrEqual(cap);
        expect(paired(clamped)).toBe(true);
      }
    }
  });

  it("clamps a text value to its cap and leaves a value within the cap byte-identical", () => {
    const clamped = boundKernelText("x".repeat(1000), 64);
    expect(clamped.length).toBe(64);
    expect(clamped.slice(25, 39)).toBe(KERNEL_TRUNCATION_MARKER);
    expect(boundKernelText(clamped, 64)).toBe(clamped);
    expect(boundKernelText("x".repeat(64), 64)).toBe("x".repeat(64));
  });

  it("names a dropped payload's mime type and keeps a text payload's head", () => {
    expect(boundKernelPayload("p".repeat(1000), "image/png", 64)).toBeNull();
    expect(boundKernelPayload("j".repeat(1000), "application/json", 64)).toBeNull();
    expect(boundKernelPayload("h".repeat(1000), "text/html", 64)?.length).toBe(64);
    expect(boundKernelPayload("s".repeat(1000), "image/svg+xml", 64)?.length).toBe(64);
    expect(boundKernelPayload("h".repeat(10), "text/html", 64)).toBe("h".repeat(10));
    expect(kernelPayloadMarker("image/png")).toBe("\n… [truncated: image/png]");
  });
});
