import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerComputeRoutes } from "./compute-routes.js";
import { RemoteComputeError, type RemoteExecuteResult, type SlurmCheckResult, type SlurmSubmitResult } from "../../runtime/compute/remote-compute-service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-compute-routes-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

function fakeService() {
  return {
    listMachines: vi.fn(async () => []),
    execute: vi.fn(async (): Promise<RemoteExecuteResult> => ({
      exitCode: 0, stdout: "ok", stderr: "", stdoutBytes: 2, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
      timedOut: false, aborted: false, remoteStop: "not_required", durationMs: 12,
      machine: { label: "gpu-box", host: "hpc", user: null, port: 22, auth_method: "key", identity_file: null },
      execution_id: "exec_test",
    })),
    slurmSubmit: vi.fn(async (): Promise<SlurmSubmitResult> => ({
      machine: { label: "cluster", host: "c", user: null, port: 22, auth_method: "key", identity_file: null },
      job_id: "42", output_path: "slurm-42.out", error_path: "slurm-42.err", raw: "Submitted batch job 42\n", execution_id: "exec_slurm", job_execution_id: "exec_job",
    })),
    slurmCheck: vi.fn(async (): Promise<SlurmCheckResult> => ({
      machine: { label: "cluster", host: "c", user: null, port: 22, auth_method: "key", identity_file: null },
      job_id: "42", state: "completed", raw_state: "COMPLETED", exit_code: "0:0", elapsed: "00:01:00",
      finished: true, query_status: "ok", output_path: "/home/pi/slurm-42.out", stdout_tail: "done", stderr_tail: null, job_execution_id: "exec_job",
    })),
  };
}

describe("compute routes", () => {
  it("executes remote commands and records provenance", async () => {
    const cwd = await makeWorkspace();
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerComputeRoutes(app, service);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/compute/execute?cwd=${encodeURIComponent(cwd)}`,
      payload: { machine_label: "gpu-box", command: "hostname", timeout_seconds: 60, session_id: "sess-1", tool_call_id: "call-1", operation_id: "op-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ exitCode: 0, execution_id: "exec_test" });
    // Canonicalize with the same function the route uses: on Windows the temp
    // dir can be an 8.3 short path that only fs/promises realpath expands.
    const canonicalCwd = await validateWorkspaceCwd(cwd);
    expect(service.execute).toHaveBeenCalledWith(canonicalCwd, expect.objectContaining({ machine_label: "gpu-box", command: "hostname", timeout_seconds: 60, session_id: "sess-1", tool_call_id: "call-1", operation_id: "op-1", signal: expect.any(AbortSignal) }));

    const provenance = await readFile(join(cwd, ".pi-science", "provenance.jsonl"), "utf8");
    expect(provenance).toContain("\"tool\":\"remote_execute\"");
    expect(provenance).toContain("exec_test");
  });

  it("submits slurm jobs and records provenance with the job id", async () => {
    const cwd = await makeWorkspace();
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerComputeRoutes(app, service);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/compute/slurm-submit?cwd=${encodeURIComponent(cwd)}`,
      payload: { machine_label: "cluster", script: "#!/bin/bash\ntrue\n", name: "exp", session_id: "sess-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ job_id: "42", output_path: "slurm-42.out" });

    const provenance = await readFile(join(cwd, ".pi-science", "provenance.jsonl"), "utf8");
    expect(provenance).toContain("\"tool\":\"slurm_submit\"");
    expect(provenance).toContain("slurm:cluster:42");
  });

  it("checks slurm jobs without writing provenance", async () => {
    const cwd = await makeWorkspace();
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerComputeRoutes(app, service);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/compute/slurm-check?cwd=${encodeURIComponent(cwd)}`,
      payload: { machine_label: "cluster", job_id: "42", include_output: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "completed", stdout_tail: "done" });
    await expect(readFile(join(cwd, ".pi-science", "provenance.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps service errors to their status codes", async () => {
    const cwd = await makeWorkspace();
    const service = fakeService();
    service.execute.mockRejectedValue(new RemoteComputeError("Machine \"x\" is not registered", 404));
    const app = Fastify({ logger: false });
    registerComputeRoutes(app, service);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/compute/execute?cwd=${encodeURIComponent(cwd)}`,
      payload: { machine_label: "x", command: "ls" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("not registered") });
  });

  it("rejects unregistered workspace paths", async () => {
    const service = fakeService();
    const app = Fastify({ logger: false });
    registerComputeRoutes(app, service);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/compute/execute?cwd=${encodeURIComponent("/definitely/not/a/workspace")}`,
      payload: { machine_label: "x", command: "ls" },
    });
    expect(response.statusCode).toBe(403);
    expect(service.execute).not.toHaveBeenCalled();
  });
});
