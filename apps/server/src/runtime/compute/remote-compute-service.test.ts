import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteComputeError, remoteComputeService, remoteWatchdogCommand, type RemoteComputeDeps } from "./remote-compute-service.js";
import { executionIdFor, executionRepository } from "../executions/execution-repository.js";
import { workspaceFile } from "../../storage/persistence.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: () => { this.stdinEnded = true; } };
  stdinEnded = false;
  killed = false;
  lastSignal: string | undefined;
  kill(signal?: string): boolean {
    this.killed = true;
    this.lastSignal = signal;
    this.emit("close", null, signal);
    return true;
  }
  out(data: string | Buffer): void { this.stdout.emit("data", Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8")); }
  err(data: string): void { this.stderr.emit("data", Buffer.from(data, "utf8")); }
  closeWith(code: number): void { this.emit("close", code, null); }
}

interface SpawnCall { command: string; args: string[] }

function spawnScript(steps: Array<(child: FakeChild) => void>) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = vi.fn((command: string, args: readonly string[]) => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ command, args: [...args] });
    const step = steps[calls.length - 1] ?? (() => child.closeWith(0));
    // runSsh attaches its listeners after spawn resolves; defer the scripted
    // output so synchronous steps cannot emit "close" before listeners exist.
    setImmediate(() => step(child));
    return child as unknown as ChildProcess;
  });
  return { spawn, calls, children };
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

/** Runs the generated remote wrapper with the local bash, so the kill path is observable without a cluster. */
function runLocal(script: string, closeStdinAfterMs?: number): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const child = spawn("bash", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  if (closeStdinAfterMs !== undefined) setTimeout(() => child.stdin.end(), closeStdinAfterMs);
  const started = Date.now();
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started })));
}

/** Recovers the command the wrapper runs, undoing the shell quoting used for the eval. */
function remotePayload(remote: string): string {
  const match = /\( eval '([\s\S]*?)' \) < \/dev\/null/.exec(remote);
  return match ? match[1]!.replaceAll("'\\''", "'") : remote;
}

describe("remoteWatchdogCommand", () => {
  it("runs the command and keeps its exit code", async () => {
    const run = await runLocal(remoteWatchdogCommand("echo ready", 30));
    expect(run.stdout).toBe("ready\n");
    expect(run.code).toBe(0);
  });

  it("stops the remote process group at the deadline and prints the marker", { timeout: 20_000 }, async () => {
    const run = await runLocal(remoteWatchdogCommand("echo begin; sleep 30; echo LATE", 1));
    expect(run.stdout).toBe("begin\n");
    expect(run.stderr).toContain("[pi-science] watchdog: deadline");
    expect(run.code).toBe(143);
    expect(run.ms).toBeLessThan(10_000);
  });

  it("stops the remote process group when the channel closes", { timeout: 20_000 }, async () => {
    const run = await runLocal(remoteWatchdogCommand("echo begin; sleep 60; echo LATE", 60), 300);
    expect(run.stdout).toBe("begin\n");
    expect(run.stderr).toContain("[pi-science] watchdog: disconnect");
    expect(run.ms).toBeLessThan(10_000);
  });
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
    const { spawn: spawnFn, calls } = spawnScript([(child) => { child.out("model ok\n"); child.closeWith(0); }]);
    const deps: RemoteComputeDeps = { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] };

    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "nvidia-smi -L" }, deps);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("model ok\n");
    expect(result.remoteStop).toBe("not_required");
    expect(result.machine.label).toBe("gpu-box");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("ssh");
    expect(remotePayload(calls[0]!.args.at(-1)!)).toContain("nvidia-smi -L");
    expect(calls[0]!.args.at(-1)).toContain("__pi_timer");
    expect(calls[0]!.args).toContain("pi@hpc.example.org");
    expect(calls[0]!.args).toContain("BatchMode=yes");

    const executions = await executionRepository.list(cwd);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ kind: "job", surface: "ssh", status: "succeeded", producer: "remote-compute-service" });
    expect(executions[0]!.request).toMatchObject({ tool: "remote_execute", machine: "gpu-box", command: ["nvidia-smi -L"] });
  });

  it("correlates the run with the session, tool call and operation", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    const { spawn: spawnFn } = spawnScript([(child) => { child.closeWith(0); }]);
    await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "ls", session_id: "sess-1", tool_call_id: "call-1", operation_id: "op-1" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    const [record] = await executionRepository.list(cwd);
    expect(record!.correlation).toMatchObject({ session_id: "sess-1", tool_call_id: "call-1", operation_id: "op-1" });
  });

  it("keeps a bounded stdout preview in the record for the Runs log view", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    const { spawn: spawnFn } = spawnScript([(child) => { child.out("x".repeat(20_000)); child.closeWith(0); }]);
    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "cat big" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.stdoutTruncated).toBe(false);
    const [record] = await executionRepository.list(cwd);
    expect(String(record!.result.stdout_preview)).toHaveLength(16_384);
    expect(record!.result.stdout_bytes).toBe(20_000);
  });

  it("decodes UTF-8 split across chunks without replacement characters", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    const bytes = Buffer.from("中文", "utf8");
    const { spawn: spawnFn } = spawnScript([(child) => { child.out(bytes.subarray(0, 4)); child.out(bytes.subarray(4)); child.closeWith(0); }]);
    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "cat zh" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.stdout).toBe("中文");
    expect(result.stdout).not.toContain("\uFFFD");
  });

  it("does not leave a running record when the SSH key is missing", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key", identity_file: "/nonexistent/id_ed25519" }]);
    await expect(remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "ls" })).rejects.toThrow(/SSH key not found/);
    await expect(executionRepository.list(cwd)).resolves.toHaveLength(0);
  });

  it("records a failed execution when the remote command exits nonzero", async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    const { spawn: spawnFn } = spawnScript([(child) => { child.err("boom"); child.closeWith(3); }]);
    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "false" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.exitCode).toBe(3);
    const executions = await executionRepository.list(cwd);
    expect(executions[0]).toMatchObject({ status: "failed" });
  });

  it("marks timed-out executions and reports an unconfirmed remote stop", { timeout: 20_000 }, async () => {
    // Real timers on purpose: the repository's file locks interleave real IO with
    // setTimeout, which limited fake timers make racy. One 4s grace is worth the wait.
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    const { spawn: spawnFn } = spawnScript([() => { /* never closes on its own */ }]);
    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "sleep 1000", timeout_seconds: 1 }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.remoteStop).toBe("unconfirmed");
    const executions = await executionRepository.list(cwd);
    expect(executions[0]).toMatchObject({ status: "timed_out" });
    expect(executions[0]!.result.remote_stop).toBe("unconfirmed");
  });

  it("confirms the remote stop when the watchdog marker arrives", { timeout: 20_000 }, async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    const { spawn: spawnFn } = spawnScript([(child) => { setTimeout(() => { child.err("[pi-science] watchdog: deadline\n"); child.closeWith(143); }, 1_200); }]);
    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "sleep 1000", timeout_seconds: 1 }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.timedOut).toBe(true);
    expect(result.remoteStop).toBe("confirmed");
    expect(result.stderr).toBe("");
  });

  it("ends the SSH channel before killing the local client on abort", { timeout: 20_000 }, async () => {
    const { cwd } = await makeWorkspace([{ label: "gpu-box", host: "hpc.example.org", auth_method: "key" }]);
    const controller = new AbortController();
    const { spawn: spawnFn, children } = spawnScript([() => { /* stays open until aborted */ }]);
    setTimeout(() => controller.abort(), 50);
    const result = await remoteComputeService.execute(cwd, { machine_label: "gpu-box", command: "sleep 1000", signal: controller.signal }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    expect(children[0]!.stdinEnded).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.remoteStop).toBe("unconfirmed");
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
  const submitted = (child: FakeChild) => { child.out("Submitted batch job 4242\nPI-SCIENCE-DIR=/home/pi\n"); child.closeWith(0); };

  it("submits the script through sbatch and records submission and job separately", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", user: "pi", auth_method: "key" }]);
    const { spawn: spawnFn, calls } = spawnScript([submitted]);

    const result = await remoteComputeService.slurmSubmit(cwd, { machine_label: "cluster", script: "#!/bin/bash\nhostname\n", name: "exp-1", session_id: "sess-9" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });

    expect(result.job_id).toBe("4242");
    expect(result.output_path).toBe("/home/pi/slurm-4242.out");
    expect(result.error_path).toBe("/home/pi/slurm-4242.err");
    const remote = remotePayload(calls[0]!.args.at(-1)!);
    expect(remote).toContain("sbatch");
    expect(remote).toContain("--job-name='exp-1'");
    expect(remote).toContain("--output=\"$__pi_dir/slurm-%j.out\"");
    const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(remote)?.[1];
    expect(encoded && Buffer.from(encoded, "base64").toString("utf8")).toBe("#!/bin/bash\nhostname\n");

    const executions = await executionRepository.list(cwd);
    const submission = executions.find((record) => record.request.tool === "slurm_submit")!;
    expect(submission).toMatchObject({ kind: "job", surface: "hpc", status: "succeeded" });
    expect(submission.result).toMatchObject({ slurm_phase: "submitted", slurm_job_id: "4242", output_path: "/home/pi/slurm-4242.out" });
    const job = executions.find((record) => record.request.tool === "slurm_job")!;
    expect(job).toMatchObject({ execution_id: executionIdFor(cwd, "slurm-job", "cluster", "4242"), status: "running" });
    expect(job.correlation).toMatchObject({ job_id: "4242", session_id: "sess-9" });
    expect(result.job_execution_id).toBe(job.execution_id);
  });

  it("rejects array job scripts instead of reporting one element's state", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    await expect(remoteComputeService.slurmSubmit(cwd, { machine_label: "cluster", script: "#SBATCH --array=1-4\nhostname" }))
      .rejects.toThrow(/Array jobs/);
    await expect(executionRepository.list(cwd)).resolves.toHaveLength(0);
  });

  it("fails loudly when sbatch reports no job id", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const { spawn: spawnFn } = spawnScript([(child) => { child.err("sbatch: error: invalid partition"); child.closeWith(1); }]);
    await expect(remoteComputeService.slurmSubmit(cwd, { machine_label: "cluster", script: "#!/bin/bash\ntrue" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] }))
      .rejects.toMatchObject({ statusCode: 502 });
    const executions = await executionRepository.list(cwd);
    expect(executions[0]).toMatchObject({ status: "failed" });
  });

  it("sanitizes unsafe job names", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const { spawn: spawnFn, calls } = spawnScript([submitted]);
    await remoteComputeService.slurmSubmit(cwd, { machine_label: "cluster", script: "true", name: "bad name'; rm -rf" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    expect(remotePayload(calls[0]!.args.at(-1)!)).toContain("--job-name='pi-science'");
  });
});

describe("remoteComputeService.slurmCheck", () => {
  const query = (queue: string, account: string) => `\x010\x01${queue}\x02\x030\x03${account}`;

  it("reports a completed job with output tails and finishes the job record", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const { spawn: spawnFn, calls } = spawnScript([
      (child) => { child.out("Submitted batch job 4242\nPI-SCIENCE-DIR=/home/pi\n"); child.closeWith(0); },
      (child) => { child.out(query("COMPLETED", "COMPLETED|0:0|00:05:00\nCOMPLETED|0:0|00:05:00")); child.closeWith(0); },
      (child) => { child.out("accuracy=0.91\n\x01warning: lr decayed"); child.closeWith(0); },
    ]);

    const submit = await remoteComputeService.slurmSubmit(cwd, { machine_label: "cluster", script: "true" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    const result = await remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "4242" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });

    expect(result).toMatchObject({ state: "completed", raw_state: "COMPLETED", exit_code: "0:0", elapsed: "00:05:00", finished: true, query_status: "ok" });
    expect(result.stdout_tail).toBe("accuracy=0.91\n");
    expect(result.stderr_tail).toBe("warning: lr decayed");
    expect(remotePayload(calls[1]!.args.at(-1)!)).toContain("squeue -j 4242");
    // The tail must read the absolute path recorded at submission, not the login directory.
    expect(remotePayload(calls[2]!.args.at(-1)!)).toContain("/home/pi/slurm-4242.out");
    expect(remotePayload(calls[2]!.args.at(-1)!)).toContain("/home/pi/slurm-4242.err");

    const job = await executionRepository.get(cwd, submit.job_execution_id);
    expect(job).toMatchObject({ status: "succeeded" });
    expect(job!.result).toMatchObject({ state: "completed", stdout_preview: "accuracy=0.91\n" });
  });

  it("reports running jobs without fetching output", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const { spawn: spawnFn, calls } = spawnScript([(child) => { child.out(query("RUNNING", "")); child.closeWith(0); }]);
    const result = await remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "77" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.state).toBe("running");
    expect(result.finished).toBe(false);
    expect(result.stdout_tail).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("aggregates array elements and steps so one failure is not hidden", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const { spawn: spawnFn } = spawnScript([(child) => { child.out(query("", "COMPLETED|0:0|00:01:00\nFAILED|1:0|00:02:00")); child.closeWith(0); }]);
    const result = await remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "42" }, { spawn: spawnFn as unknown as RemoteComputeDeps["spawn"] });
    expect(result.state).toBe("failed");
    expect(result.raw_state).toBe("COMPLETED,FAILED");
  });

  it("distinguishes a missing job from a failed query", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    const missing = spawnScript([(child) => { child.out(query("", "slurm_load_jobs error: Invalid job id specified")); child.closeWith(0); }]);
    const missingResult = await remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "999" }, { spawn: missing.spawn as unknown as RemoteComputeDeps["spawn"] });
    expect(missingResult).toMatchObject({ state: "unknown", query_status: "no_records" });

    const broken = spawnScript([(child) => { child.out(query("", "slurm_load_jobs error: Socket timed out on send/recv operation")); child.closeWith(0); }]);
    await expect(remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "999" }, { spawn: broken.spawn as unknown as RemoteComputeDeps["spawn"] }))
      .rejects.toThrow(/Scheduler query failed.*Socket timed out/);

    const unreachable = spawnScript([(child) => { child.err("ssh: connect to host cluster.example.org port 22: Connection refused"); child.closeWith(255); }]);
    await expect(remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "999" }, { spawn: unreachable.spawn as unknown as RemoteComputeDeps["spawn"] }))
      .rejects.toMatchObject({ statusCode: 502 });
  });

  it("rejects non-numeric job ids", async () => {
    const { cwd } = await makeWorkspace([{ label: "cluster", host: "cluster.example.org", auth_method: "key" }]);
    await expect(remoteComputeService.slurmCheck(cwd, { machine_label: "cluster", job_id: "4242; rm -rf" })).rejects.toBeInstanceOf(RemoteComputeError);
  });
});
