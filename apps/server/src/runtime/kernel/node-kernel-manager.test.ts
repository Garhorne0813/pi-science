import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeKernelManager, type KernelResult } from "./node-kernel-manager.js";
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
function systemRscript(): string | null {
  const command = process.platform === "win32" ? "Rscript.exe" : "Rscript";
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return result.status === 0 ? command : null;
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
    const spawned: { args: string[]; options?: SpawnOptions }[] = [];
    const treeKills: number[] = [];
    const sessions: FakeSession[] = [];
    const manager = new NodeKernelManager({
      platform,
      workspaceEnvironmentVariables: () => ({}),
      interpreterAvailable: () => true,
      spawnProcess: ((command: string, args: readonly string[], options?: SpawnOptions) => {
        spawned.push({ args: [...args], options });
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
      (session.child.stdout as PassThrough).write(`${JSON.stringify({ id: request.id, type: "result", ok: true, stdout: "", result: "2", error: null, interrupted: false, ...overrides })}\n`);
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

  it.skipIf(rscript === null)("executes cells through the real R bridge with a persistent namespace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-r-bridge-"));
    cleanup.push(workspace);
    const prefix = join(workspace, "env");
    const binDir = join(prefix, process.platform === "win32" ? "Scripts" : "bin");
    await mkdir(binDir, { recursive: true });
    await symlink(rscript!, join(binDir, process.platform === "win32" ? "Rscript.exe" : "Rscript"));

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
  });

});
