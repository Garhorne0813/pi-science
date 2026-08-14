import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RemoteJobCoordinator, type RemoteJobRecord } from "./remote-job.js";
import type { ComputeMachine, RemoteExecResult, SshExecutor } from "./ssh-executor.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspace(machine?: ComputeMachine): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-remote-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  if (machine) await writeFile(join(cwd, ".pi-science", "compute.json"), JSON.stringify({ machines: [machine] }), "utf8");
  return cwd;
}

function stubExecutor(impl: (machine: ComputeMachine, remoteCommand: string, stdin?: string) => Promise<RemoteExecResult>): SshExecutor {
  return { run: vi.fn(impl) };
}

const ok = (stdout = "", exitCode = 0): RemoteExecResult => ({ success: true, stdout, stderr: "", exitCode });

describe("RemoteJobCoordinator", () => {
  it("submits a job: stages the script, launches remotely, persists the record", async () => {
    const machine: ComputeMachine = { label: "gpu", host: "192.168.1.10", user: "alice" };
    const cwd = await workspace(machine);
    const executor = stubExecutor(async (_m, remoteCommand) => {
      if (remoteCommand.includes("cat > ")) return ok("12345\n");
      return ok("");
    });
    const publish = vi.fn(async () => ({ artifact_id: "a1" }));
    const coordinator = new RemoteJobCoordinator(executor, publish);

    const job = await coordinator.submit(cwd, { machine_label: "gpu", command: ["python", "train.py"], output_glob: "*.csv" });
    expect(job).toMatchObject({ status: "running", remote_pid: "12345", machine_label: "gpu" });
    expect((job as RemoteJobRecord).script_sha256).toHaveLength(16);
    // Staged script exists locally.
    const staged = await readFile(join(cwd, ".pi-science", "staging", (job as RemoteJobRecord).job_id, "run.sh"), "utf8");
    expect(staged).toContain("python");
    expect(staged).toContain("train.py");
    expect(staged).toMatch(/\ncd ~\/\.pi-jobs\/[a-f0-9]+\npython train\.py\n/);
    expect(staged).toContain("exit_code=$?");
    // Record persisted.
    const record = await coordinator.get(cwd, (job as RemoteJobRecord).job_id);
    expect(record?.status).toBe("running");
  });

  it("rejects unknown machines and launch failures", async () => {
    const cwd = await workspace();
    const executor = stubExecutor(async () => ok(""));
    const coordinator = new RemoteJobCoordinator(executor, vi.fn(async () => ({ artifact_id: "a" })));

    const missing = await coordinator.submit(cwd, { machine_label: "nope", command: ["echo", "hi"] });
    expect(missing).toMatchObject({ code: "machine_not_found" });

    await writeFile(join(cwd, ".pi-science", "compute.json"), JSON.stringify({ machines: [{ label: "gpu", host: "h" }] }), "utf8");
    const failing = stubExecutor(async () => ({ success: false, stdout: "", stderr: "Connection refused", exitCode: 255 }));
    const failingCoordinator = new RemoteJobCoordinator(failing, vi.fn(async () => ({ artifact_id: "a" })));
    const result = await failingCoordinator.submit(cwd, { machine_label: "gpu", command: ["echo", "hi"] });
    expect(result).toMatchObject({ code: "launch_failed" });
  });

  it("refreshes status from the remote probe and records the exit code", async () => {
    const machine: ComputeMachine = { label: "gpu", host: "h" };
    const cwd = await workspace(machine);
    const executor = stubExecutor(async (_m, cmd) => {
      if (cmd.includes("kill -0")) return ok("exited\n");
      if (cmd.includes("cat ")) return ok("0\n");
      return ok("");
    });
    const coordinator = new RemoteJobCoordinator(executor, vi.fn(async () => ({ artifact_id: "a" })));
    const job = await coordinator.submit(cwd, { machine_label: "gpu", command: ["true"] });

    const refreshed = await coordinator.refresh(cwd, (job as RemoteJobRecord).job_id);
    expect(refreshed?.status).toBe("succeeded");
    expect(refreshed?.exit_code).toBe(0);
    expect(refreshed?.ended_at).not.toBeNull();
  });

  it("marks a non-zero remote exit as failed", async () => {
    const machine: ComputeMachine = { label: "gpu", host: "h" };
    const cwd = await workspace(machine);
    const executor = stubExecutor(async (_m, cmd) => {
      if (cmd.includes("kill -0")) return ok("failed\n");
      if (cmd.includes("cat ")) return ok("7\n");
      return ok("");
    });
    const coordinator = new RemoteJobCoordinator(executor, vi.fn(async () => ({ artifact_id: "a" })));
    const job = await coordinator.submit(cwd, { machine_label: "gpu", command: "python train.py" });

    const refreshed = await coordinator.refresh(cwd, (job as RemoteJobRecord).job_id);
    expect(refreshed).toMatchObject({ status: "failed", exit_code: 7 });
  });

  it("rejects shell operators in output globs", async () => {
    const machine: ComputeMachine = { label: "gpu", host: "h" };
    const cwd = await workspace(machine);
    const coordinator = new RemoteJobCoordinator(stubExecutor(async () => ok("")), vi.fn(async () => ({ artifact_id: "a" })));

    const result = await coordinator.submit(cwd, { machine_label: "gpu", command: "echo ok", output_glob: "*; rm -rf /" });
    expect(result).toMatchObject({ code: "invalid_output_glob" });
  });

  it("cancels a running job and marks it cancelled", async () => {
    const machine: ComputeMachine = { label: "gpu", host: "h" };
    const cwd = await workspace(machine);
    const kill = stubExecutor(async (_m, cmd) => {
      if (cmd.includes("cat > ")) return ok("77\n");
      return ok("");
    });
    const coordinator = new RemoteJobCoordinator(kill, vi.fn(async () => ({ artifact_id: "a" })));
    const job = await coordinator.submit(cwd, { machine_label: "gpu", command: ["sleep", "100"] });

    const cancelled = await coordinator.cancel(cwd, (job as RemoteJobRecord).job_id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.ended_at).not.toBeNull();
    const record = await coordinator.get(cwd, (job as RemoteJobRecord).job_id);
    expect(record?.status).toBe("cancelled");
  });

  it("harvests declared outputs back and publishes them as artifacts", async () => {
    const machine: ComputeMachine = { label: "gpu", host: "h" };
    const fetchedCommands: string[] = [];
    const cwd = await workspace(machine);
    const executor = stubExecutor(async (_m, cmd) => {
      if (cmd.includes("kill -0")) return ok("exited\n");
      if (cmd.includes("for f in")) return ok("results.csv 8\noutput.log 500\nexit.code 2\n");
      if (cmd.includes("exit.code")) return ok("0\n");
      if (cmd.includes("base64")) {
        fetchedCommands.push(cmd);
        return ok(Buffer.from("a,b\n1,2\n").toString("base64"));
      }
      if (cmd.includes("cat > ")) return ok("88\n");
      return ok("");
    });
    const publish = vi.fn(async () => ({ artifact_id: "artifact-1" }));
    const coordinator = new RemoteJobCoordinator(executor, publish);
    const job = await coordinator.submit(cwd, { machine_label: "gpu", command: ["python", "go.py"], output_glob: "results.csv" });

    const harvested = await coordinator.harvest(cwd, (job as RemoteJobRecord).job_id);
    expect(harvested.files).toEqual(["results.csv"]);
    expect(harvested.artifact_ids).toEqual(["artifact-1"]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(fetchedCommands[0]).toMatch(/base64 \"\$HOME\/\.pi-jobs\/\"[a-f0-9]+\"\/\"results\.csv$/);
    // The harvested file exists in the workspace.
    const content = await readFile(join(cwd, "results.csv"), "utf8");
    expect(content).toBe("a,b\n1,2\n");
    // The record now carries the artifact id.
    const record = await coordinator.get(cwd, (job as RemoteJobRecord).job_id);
    expect(record?.artifact_ids).toEqual(["artifact-1"]);
  });

  it("refuses to harvest a job that is still running", async () => {
    const machine: ComputeMachine = { label: "gpu", host: "h" };
    const cwd = await workspace(machine);
    const executor = stubExecutor(async (_m, cmd) => {
      if (cmd.includes("cat > ")) return ok("99\n");
      if (cmd.includes("kill -0")) return ok("running\n");
      return ok("");
    });
    const coordinator = new RemoteJobCoordinator(executor, vi.fn(async () => ({ artifact_id: "a" })));
    const job = await coordinator.submit(cwd, { machine_label: "gpu", command: ["sleep", "5"] });
    const harvested = await coordinator.harvest(cwd, (job as RemoteJobRecord).job_id);
    expect(harvested.error).toContain("not finished");
    expect(harvested.files).toEqual([]);
  });
});
