import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteComputeError, remoteComputeService, type RemoteComputeDeps } from "./remote-compute-service.js";
import { executionRepository } from "../executions/execution-repository.js";
import { workspaceFile } from "../../storage/persistence.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  lastSignal: string | undefined;
  kill(signal?: string): boolean {
    this.killed = true;
    this.lastSignal = signal;
    this.emit("close", null, signal);
    return true;
  }
  out(data: string): void { this.stdout.emit("data", Buffer.from(data, "utf8")); }
  err(data: string): void { this.stderr.emit("data", Buffer.from(data, "utf8")); }
  closeWith(code: number): void { this.emit("close", code, null); }
}

interface SpawnCall { command: string; args: string[] }

function spawnScript(steps: Array<(child: FakeChild) => void>) {
  const calls: SpawnCall[] = [];
  const spawn = vi.fn((command: string, args: readonly string[]) => {
    const child = new FakeChild();
    calls.push({ command, args: [...args] });
    const step = steps[calls.length - 1] ?? (() => child.closeWith(0));
    // runSsh attaches its listeners after spawn resolves; defer the scripted
    // output so synchronous steps cannot emit "close" before listeners exist.
    setImmediate(() => step(child));
    return child as unknown as ChildProcess;
  });
  return { spawn, calls };
}

const workspaces: string[] = [];

async function makeWorkspace(machines: unknown[]): Promise<{ cwd: string; keyPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-remote-compute-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  const keyPath = join(cwd, "id_ed25519");
  await writeFile(keyPath, "test-key", "utf8");
  const normalized = (machines as Array<Record<string, unknown>>).map((machine) => ({ identity_file: keyPath, ...machine }));
  await writeFile(workspaceFile(cwd, "compute.json"), JSON.stringify({ machines: normalized }), "utf8");
  return { cwd, keyPath };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("remoteComputeService.listMachines", () => {
  it("returns sanitized machine summaries from the workspace registry", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", user: "pi", port: 2222, auth_method: "key" }]);
    const machines = await remoteComputeService.listMachines(cwd);
    expect(machines).toEqual([
      { label: "gpu-box", host: "hpc.example.org", user: "pi", port: 2222, auth_method: "key", identity_file: expect.any(String) },
    ]);
  });
});

describe("remoteComputeService.execute", () => {
  it("runs the command over ssh and records a succeeded execution", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", user: "pi", auth_method: "key" }]);
    const { spawn, calls } = spawnScript([(child) => { child.out("model ok\n"); child.closeWith(0); }]);
    const deps: RemoteComputeDeps = { spawn: spawn as unknown as RemoteComputeDeps["spawn"] };

    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "nvidia-smi -L" }, deps);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("model ok\n");
    expect(result.machine.label).toBe("gpu-box");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("ssh");
    expect(calls[0]!.args.at(-1)).toBe("nvidia-smi -L");
    expect(calls[0]!.args).toContain("pi@hpc.example.org");
    expect(calls[0]!.args).toContain("BatchMode=yes");

    const executions = await executionRepository.list(cwd);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ kind: "job", surface: "ssh", status: "succeeded", producer: "remote-compute-service" });
    expect(executions[0]!.request).toMatchObject({ tool: "remote_execute", machine: "gpu-box", command: ["nvidia-smi -L"] });
  });

  it("records a failed execution when the remote command exits nonzero", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    const { spawn } = spawnScript([(child) => { child.err("boom"); child.closeWith(3); }]);
    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "false" }, { spawn: spawn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.exitCode).toBe(3);
    const executions = await executionRepository.list(cwd);
    expect(executions[0]).toMatchObject({ status: "failed" });
  });

  it("marks timed-out executions and kills the ssh process", { timeout: 20_000 }, async () => {
    // Real timers on purpose: the repository's file locks interleave real IO with
    // setTimeout, which limited fake timers make racy. One 6s grace is worth the wait.
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    const { spawn } = spawnScript([() => { /* never closes on its own */ }]);
    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "sleep 1000", timeout_seconds: 1 }, { spawn: spawn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    const executions = await executionRepository.list(cwd);
    expect(executions[0]).toMatchObject({ status: "timed_out" });
  });

  it("rejects unknown machines with the registered labels", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    await expect(remoteComputeService.execute(cwd, { machine_label: "nope", command: "ls" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(remoteComputeService.execute(cwd, { machine_label: "nope", command: "ls" })).rejects.toThrow(/gpu-box/);
  });

  it("rejects password-registered machines for execution", async () => {
    const { cwd } = await makeWorkspace([{ label: "pw-box", host: "hpc.example.org", auth_method: "password" }]);
    await expect(remoteComputeService.execute(cwd, { machine_label: "pw-box", command: "ls" })).rejects.toThrow(/key-based machine/);
  });

  it("rejects empty and oversized commands", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    await expect(remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "   " })).rejects.toBeInstanceOf(RemoteComputeError);
    await expect(remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "x".repeat(32_769) })).rejects.toThrow(/32,?768 characters/);
  });
});

describe("remoteComputeService.slurmSubmit", () => {
  it("submits the script through sbatch and returns job identity", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", user: "pi", auth_method: "key" }]);
    const { spawn, calls } = spawnScript([(child) => { child.out("Submitted batch job 4242\n"); child.closeWith(0); }]);

    const result = await remoteComputeService.slurmSubmit(cwd, { machine_label: "cluster", script: "#!/bin/bash\nhostname\n", name: "exp-1" }, { spawn: spawn as unknown as RemoteComputeDeps["spawn"] });

    expect(result.job_id).toBe("4242");
    expect(result.output_path).toBe("slurm-4242.out");
    expect(result.error_path).toBe("slurm-4242.err");
    const remote = calls[0]!.args.at(-1)!;
    expect(remote).toContain("sbatch");
    expect(remote).toContain("--job-name='exp-1'");
    const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(remote)?.[1];
    expect(encoded && Buffer.from(encoded, "base64").toString("utf8")).toBe("#!/bin/bash\nhostname\n");

    const executions = await executionRepository.list(cwd);
    expect(executions[0]).toMatchObject({ kind: "job", surface: "hpc", status: "succeeded" });
  });

  it("fails loudly when sbatch reports no job id", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const { spawn } = spawnScript([(child) => { child.err("sbatch: error: invalid partition"); child.closeWith(1); }]);
    await expect(remoteComputeService.slurmSubmit(cwd, { machine_label: "cluster", script: "#!/bin/bash\ntrue" }, { spawn: spawn as unknown as RemoteComputeDeps["spawn"] }))
      .rejects.toMatchObject({ statusCode: 502 });
    const executions = await executionRepository.list(cwd);
    expect(executions[0]).toMatchObject({ status: "failed" });
  });

  it("sanitizes unsafe job names", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const { spawn, calls } = spawnScript([(child) => { child.out("Submitted batch job 1\n"); child.closeWith(0); }]);
    await remoteComputeService.slurmSubmit(cwd, { machine_label: "cluster", script: "true", name: "bad name'; rm -rf" }, { spawn: spawn as unknown as RemoteComputeDeps["spawn"] });
    expect(calls[0]!.args.at(-1)).toContain("--job-name='pi-science'");
  });
});

describe("remoteComputeService.slurmCheck", () => {
  it("reports a completed job with output tails", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const { spawn, calls } = spawnScript([
      (child) => { child.out("COMPLETED\x01COMPLETED|0:0|00:05:00"); child.closeWith(0); },
      (child) => { child.out("accuracy=0.91\n\x01warning: lr decayed"); child.closeWith(0); },
    ]);

    const result = await remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "4242" }, { spawn: spawn as unknown as RemoteComputeDeps["spawn"] });

    expect(result).toMatchObject({ state: "completed", raw_state: "COMPLETED", exit_code: "0:0", elapsed: "00:05:00", finished: true });
    expect(result.stdout_tail).toBe("accuracy=0.91\n");
    expect(result.stderr_tail).toBe("warning: lr decayed");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args.at(-1)).toContain("squeue -j 4242");
  });

  it("reports running jobs without fetching output", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const { spawn, calls } = spawnScript([(child) => { child.out("RUNNING\x01"); child.closeWith(0); }]);
    const result = await remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "77" }, { spawn: spawn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.state).toBe("running");
    expect(result.finished).toBe(false);
    expect(result.stdout_tail).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("rejects non-numeric job ids", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    await expect(remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "4242; rm -rf" })).rejects.toBeInstanceOf(RemoteComputeError);
  });
});
