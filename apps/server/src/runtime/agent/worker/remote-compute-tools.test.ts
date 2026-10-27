import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteComputeTools } from "./remote-compute-tools.js";
import type { InteractionBridge } from "./interaction-bridge.js";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

let fetchMock: FetchMock;
let interactions: { confirmPermission: ReturnType<typeof vi.fn> };

beforeEach(() => {
  process.env.PI_SCIENCE_INTERNAL_TOKEN = "test-token";
  process.env.PI_SCIENCE_BACKEND_URL = "http://127.0.0.1:8999";
  fetchMock = vi.fn(async () => jsonResponse({}));
  vi.stubGlobal("fetch", fetchMock);
  interactions = { confirmPermission: vi.fn(async () => true) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PI_SCIENCE_INTERNAL_TOKEN;
  delete process.env.PI_SCIENCE_BACKEND_URL;
  vi.restoreAllMocks();
});

function tools() {
  return remoteComputeTools("/workspace/project", interactions as unknown as InteractionBridge, "session-1");
}

async function run(tool: ReturnType<typeof tools>["machines"], params: unknown) {
  return await tool.execute("call-1", params, undefined as never, undefined as never, { operationId: "op", invocationId: "inv" } as never, { abortSignal: undefined } as never);
}

function approvalText(): string {
  const [, message] = interactions.confirmPermission.mock.calls[0]! as [string, string];
  return message;
}

describe("remote_machines", () => {
  it("lists registered machines through the control plane", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ machines: [{ label: "gpu-box", host: "hpc.example.org", user: "pi", port: 2222, auth_method: "key" }] }));
    const result = await run(tools().machines, {});
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("pi@hpc.example.org:2222") });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8999/api/compute/machines?cwd=%2Fworkspace%2Fproject",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect((init.headers as Headers).get("x-pi-science-internal-token")).toBe("test-token");
  });

  it("explains when no machines are registered", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ machines: [] }));
    const result = await run(tools().machines, {});
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("No machines are registered") });
  });
});

describe("remote_execute", () => {
  it("requires user approval before dispatching", async () => {
    interactions.confirmPermission.mockResolvedValueOnce(false);
    const result = await run(tools().execute, { machine: "gpu-box", command: "hostname" });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the whole command in the approval, not a preview", async () => {
    const command = `echo start\n${"sleep 1; ".repeat(120)}echo "${"x".repeat(600)}"`;
    fetchMock.mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, aborted: false, stdoutTruncated: false, execution_id: "exec_1" }));
    await run(tools().execute, { machine: "gpu-box", command });
    expect(approvalText()).toContain(command);
    expect(approvalText()).not.toContain("…");
  });

  it("posts the command with session correlation and presents exit code and output", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "gpu-0\n", stderr: "", durationMs: 42, timedOut: false, aborted: false, stdoutTruncated: false, execution_id: "exec_1" }));
    const result = await run(tools().execute, { machine: "gpu-box", command: "nvidia-smi -L", timeout_seconds: 120 });
    expect(interactions.confirmPermission).toHaveBeenCalledWith(
      expect.stringContaining("gpu-box"),
      expect.stringContaining("nvidia-smi -L"),
      undefined,
      "call-1",
    );
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8999/api/compute/execute?cwd=%2Fworkspace%2Fproject");
    expect(JSON.parse(String(init.body))).toEqual({
      machine_label: "gpu-box", command: "nvidia-smi -L", timeout_seconds: 120,
      session_id: "session-1", tool_call_id: "call-1", operation_id: "op",
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("exit_code: 0") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("gpu-0") });
  });

  it("truncates oversized output for the conversation and names the bounded record", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "x".repeat(60_000), stderr: "", durationMs: 1, timedOut: false, aborted: false, stdoutTruncated: true, execution_id: "exec_1" }));
    const result = await run(tools().execute, { machine: "gpu-box", command: "cat big.txt" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text.length).toBeLessThan(40_000);
    expect(text).toContain("output truncated");
    expect(text).toContain("bounded preview");
  });

  it("distinguishes a confirmed remote stop from a local-only kill", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ exitCode: null, stdout: "", stderr: "", durationMs: 1_000, timedOut: true, aborted: false, stdoutTruncated: false, remoteStop: "confirmed", execution_id: "exec_1" }));
    expect((await run(tools().execute, { machine: "gpu-box", command: "sleep 900" })).content[0]).toMatchObject({ text: expect.stringContaining("remote watchdog stopped") });
    fetchMock.mockResolvedValueOnce(jsonResponse({ exitCode: null, stdout: "", stderr: "", durationMs: 1_000, timedOut: true, aborted: false, stdoutTruncated: false, remoteStop: "unconfirmed", execution_id: "exec_2" }));
    expect((await run(tools().execute, { machine: "gpu-box", command: "sleep 900" })).content[0]).toMatchObject({ text: expect.stringContaining("may still be running") });
  });

  it("rejects oversized commands before asking for approval", async () => {
    await expect(run(tools().execute, { machine: "gpu-box", command: "x".repeat(32_769) })).rejects.toThrow(/32768 characters/);
    expect(interactions.confirmPermission).not.toHaveBeenCalled();
  });

  it("surfaces control plane errors as tool failures", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Machine \"gpu-box\" is not registered" }, 404));
    await expect(run(tools().execute, { machine: "gpu-box", command: "ls" })).rejects.toThrow(/not registered/);
  });
});

describe("slurm_submit", () => {
  it("requires approval and reports the job id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ job_id: "4242", output_path: "/home/pi/slurm-4242.out", error_path: "/home/pi/slurm-4242.err", execution_id: "exec_2", job_execution_id: "exec_job" }));
    const result = await run(tools().submit, { machine: "cluster", script: "#!/bin/bash\nhostname\n", name: "exp-1" });
    expect(interactions.confirmPermission).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8999/api/compute/slurm-submit?cwd=%2Fworkspace%2Fproject");
    expect(JSON.parse(String(init.body))).toEqual({
      machine_label: "cluster", script: "#!/bin/bash\nhostname\n", name: "exp-1",
      session_id: "session-1", tool_call_id: "call-1", operation_id: "op",
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("job_id: 4242") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("the job has not run to completion") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("/home/pi/slurm-4242.out") });
  });

  it("shows the whole script in the approval", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ job_id: "1", output_path: "a", error_path: "b", execution_id: "e", job_execution_id: "j" }));
    const script = `#!/bin/bash\n${"#SBATCH --mem=8G\n".repeat(80)}python train.py`;
    await run(tools().submit, { machine: "cluster", script });
    expect(approvalText()).toContain("python train.py");
    expect(approvalText()).toContain(script);
  });

  it("rejects array jobs before asking for approval", async () => {
    await expect(run(tools().submit, { machine: "cluster", script: "#SBATCH --array=1-8\nhostname" })).rejects.toThrow(/Array jobs/);
    expect(interactions.confirmPermission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an error result when the user denies submission", async () => {
    interactions.confirmPermission.mockResolvedValueOnce(false);
    const result = await run(tools().submit, { machine: "cluster", script: "true" });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("slurm_check", () => {
  it("reports job state, the recorded output path and output tails without approval", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "completed", raw_state: "COMPLETED", exit_code: "0:0", elapsed: "00:05:00", finished: true, query_status: "ok", output_path: "/home/pi/slurm-4242.out", stdout_tail: "accuracy=0.91", stderr_tail: null }));
    const result = await run(tools().check, { machine: "cluster", job_id: "4242" });
    expect(interactions.confirmPermission).not.toHaveBeenCalled();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("state: completed (COMPLETED)");
    expect(text).toContain("/home/pi/slurm-4242.out");
    expect(text).toContain("accuracy=0.91");
  });

  it("does not present a missing accounting record as proof the job never ran", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "unknown", raw_state: "UNKNOWN", exit_code: null, elapsed: null, finished: false, query_status: "no_records", output_path: "slurm-999.out", stdout_tail: null, stderr_tail: null }));
    const text = (await run(tools().check, { machine: "cluster", job_id: "999" })).content[0] as { type: "text"; text: string };
    expect(text.text).toContain("not evidence that the job never ran");
  });
});
