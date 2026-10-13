import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeKernelManager } from "./node-kernel-manager.js";
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
const cleanup: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
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

/** A loopback listener gives the cell a reachable address, so a denied
 *  connection reads as EPERM instead of an unreachable-network error. */
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
    "import json, socket, subprocess, sys",
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
    "print(json.dumps(outcome))",
  ].join("\n");
}

async function escapeOutcome(code: string, workspace: string, prefix: string): Promise<Record<string, string>> {
  const manager = new NodeKernelManager();
  try {
    const result = await manager.execute({ language: "python", code, cwd: workspace, environment: status(workspace, prefix), timeoutMs: 30_000 });
    expect(result.ok, result.error ?? "").toBe(true);
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    return JSON.parse(line) as Record<string, string>;
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

    const outcome = await escapeOutcome(escapeCell(workspace, outsideSecret, outsideTarget, port), workspace, prefix);

    expect(outcome).toMatchObject({
      read_outside: "allowed",
      write_outside: "allowed",
      read_workspace_metadata: "allowed",
      network: "allowed",
      subprocess_network: "allowed",
      workspace_write: "allowed",
    });
  });
});
