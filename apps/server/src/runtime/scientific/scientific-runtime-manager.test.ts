import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ScientificRuntimeManager } from "./scientific-runtime-manager.js";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 4242,
    exitCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  child.kill = vi.fn(() => {
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

describe("ScientificRuntimeManager", () => {
  it("deduplicates concurrent cold starts and tracks active requests", async () => {
    const child = fakeChild();
    const spawnWorker = vi.fn(() => child) as unknown as typeof spawn;
    const manager = new ScientificRuntimeManager(
      {
        origin: "http://127.0.0.1:8788",
        managed: true,
        pythonExecutable: "/python",
        pythonCwd: "/backend",
        idleTimeoutMs: 60_000,
      },
      { spawnWorker, checkHealth: vi.fn(async () => true) },
    );

    const [releaseFirst, releaseSecond] = await Promise.all([manager.acquire(), manager.acquire()]);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()).toMatchObject({ state: "ready", pid: 4242, activeRequests: 2 });

    releaseFirst();
    releaseSecond();
    expect(manager.snapshot().activeRequests).toBe(0);
    await manager.shutdown();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.snapshot().state).toBe("idle");
  });

  it("rejects a request when an externally managed runtime is unavailable", async () => {
    const manager = new ScientificRuntimeManager(
      { origin: "http://127.0.0.1:8788" },
      { checkHealth: vi.fn(async () => false) },
    );
    await expect(manager.acquire()).rejects.toThrow("scientific runtime is unavailable");
    expect(manager.snapshot()).toMatchObject({ state: "external", activeRequests: 0 });
  });

  it("reclaims a managed worker after its idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const manager = new ScientificRuntimeManager(
        {
          origin: "http://127.0.0.1:8788",
          managed: true,
          pythonExecutable: "/python",
          pythonCwd: "/backend",
          idleTimeoutMs: 25,
        },
        {
          spawnWorker: vi.fn(() => child) as unknown as typeof spawn,
          checkHealth: vi.fn(async () => true),
        },
      );
      const release = await manager.acquire();
      release();
      await vi.advanceTimersByTimeAsync(25);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(manager.snapshot().state).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});
