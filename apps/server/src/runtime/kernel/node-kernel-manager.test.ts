import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeKernelManager } from "./node-kernel-manager.js";
import type { WorkspaceEnvironmentStatus } from "../workspace/workspace-environment.js";

function systemPython(): string | null {
  const result = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const python = systemPython();
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

function status(workspace: string, prefix: string): WorkspaceEnvironmentStatus {
  const bin = join(prefix, "bin");
  return {
    ready: true,
    workspace,
    prefix,
    python: join(bin, "python"),
    pip: join(bin, "pip"),
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
    const bin = join(prefix, "bin");
    await mkdir(bin, { recursive: true });
    await symlink(python!, join(bin, "python"));

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
    const bin = join(prefix, "bin");
    await mkdir(bin, { recursive: true });
    await symlink(python!, join(bin, "python"));

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
    const bin = join(prefix, "bin");
    await mkdir(bin, { recursive: true });
    await symlink(python!, join(bin, "python"));
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
    const bin = join(prefix, "bin");
    await mkdir(bin, { recursive: true });
    await symlink(python!, join(bin, "python"));

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

});
