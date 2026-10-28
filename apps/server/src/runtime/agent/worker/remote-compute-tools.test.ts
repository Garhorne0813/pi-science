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
  return remoteComputeTools("/workspace/project", interactions as unknown as InteractionBridge);
}

async function run(tool: ReturnType<typeof tools>["machines"], params: unknown) {
  return await tool.execute("call-1", params, undefined as never, undefined as never, { operationId: "op", invocationId: "inv" } as never, { abortSignal: undefined } as never);
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

  it("posts the command and presents exit code and output", async () => {
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
    expect(JSON.parse(String(init.body))).toEqual({ machine_label: "gpu-box", command: "nvidia-smi -L", timeout_seconds: 120 });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("exit_code: 0") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("gpu-0") });
  });

  it("truncates oversized output for the conversation", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "x".repeat(60_000), stderr: "", durationMs: 1, timedOut: false, aborted: false, stdoutTruncated: true, execution_id: "exec_1" }));
    const result = await run(tools().execute, { machine: "gpu-box", command: "cat big.txt" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text.length).toBeLessThan(40_000);
    expect(text).toContain("output truncated");
  });

  it("surfaces control plane errors as tool failures", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Machine \"gpu-box\" is not registered" }, 404));
    await expect(run(tools().execute, { machine: "gpu-box", command: "ls" })).rejects.toThrow(/not registered/);
  });
});

describe("slurm_submit", () => {
  it("requires approval and reports the job id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ job_id: "4242", output_path: "slurm-4242.out", error_path: "slurm-4242.err", execution_id: "exec_2" }));
    const result = await run(tools().submit, { machine: "cluster", script: "#!/bin/bash\nhostname\n", name: "exp-1" });
    expect(interactions.confirmPermission).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8999/api/compute/slurm-submit?cwd=%2Fworkspace%2Fproject");
    expect(JSON.parse(String(init.body))).toEqual({ machine_label: "cluster", script: "#!/bin/bash\nhostname\n", name: "exp-1" });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("job_id: 4242") });
  });

  it("returns an error result when the user denies submission", async () => {
    interactions.confirmPermission.mockResolvedValueOnce(false);
    const result = await run(tools().submit, { machine: "cluster", script: "true" });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("slurm_check", () => {
  it("reports job state and output tails without approval", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "completed", raw_state: "COMPLETED", exit_code: "0:0", elapsed: "00:05:00", finished: true, stdout_tail: "accuracy=0.91", stderr_tail: null }));
    const result = await run(tools().check, { machine: "cluster", job_id: "4242" });
    expect(interactions.confirmPermission).not.toHaveBeenCalled();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("state: completed (COMPLETED)");
    expect(text).toContain("accuracy=0.91");
  });
});
