import Fastify from "fastify";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executionRepository } from "../../runtime/executions/execution-repository.js";
import { registerExecutionRoutes } from "./execution-routes.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-science-execution-routes-"));
  workspaces.push(path);
  await mkdir(join(path, ".pi-science"), { recursive: true });
  return path;
}

describe("execution routes", () => {
  it("lists, filters, reads, and exposes logs for executions", async () => {
    const cwd = await workspace();
    await executionRepository.start(cwd, {
      execution_id: "exec-route",
      kind: "tool",
      surface: "pi",
      producer: "test",
      correlation: { session_id: "session-route", tool_call_id: "call-route" },
      request: { tool: "read" },
    });
    await executionRepository.finish(cwd, "exec-route", {
      status: "succeeded",
      producer: "test",
      result: { stdout_preview: "output", stderr_preview: "diagnostic" },
    });

    const app = Fastify();
    registerExecutionRoutes(app);
    const list = await app.inject({ method: "GET", url: `/api/executions?cwd=${encodeURIComponent(cwd)}&session_id=session-route` });
    expect(list.statusCode).toBe(200);
    expect(list.json().executions).toEqual([expect.objectContaining({ execution_id: "exec-route", status: "succeeded" })]);

    const detail = await app.inject({ method: "GET", url: `/api/executions/exec-route?cwd=${encodeURIComponent(cwd)}` });
    expect(detail.json()).toMatchObject({ correlation: { tool_call_id: "call-route" } });
    const logs = await app.inject({ method: "GET", url: `/api/executions/exec-route/logs?cwd=${encodeURIComponent(cwd)}` });
    expect(logs.json()).toMatchObject({ stdout: "output", stderr: "diagnostic", source: "preview", complete: false });
  });

  it("uses the job store for the best available execution log", async () => {
    const cwd = await workspace();
    await executionRepository.start(cwd, {
      execution_id: "exec-job-route",
      kind: "job",
      surface: "local",
      producer: "test",
      correlation: { job_id: "job_1234567890abcdef" },
    });
    const app = Fastify();
    registerExecutionRoutes(app, {
      logs: async () => ({
        job_id: "job_1234567890abcdef",
        stdout: "complete output",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
      }),
    });

    const response = await app.inject({ method: "GET", url: `/api/executions/exec-job-route/logs?cwd=${encodeURIComponent(cwd)}` });
    expect(response.json()).toMatchObject({ stdout: "complete output", source: "job", complete: true });
  });

  it("rejects invalid filters and unknown executions", async () => {
    const cwd = await workspace();
    const app = Fastify();
    registerExecutionRoutes(app);
    expect((await app.inject({ method: "GET", url: `/api/executions?cwd=${encodeURIComponent(cwd)}&kind=nope` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/executions/missing?cwd=${encodeURIComponent(cwd)}` })).statusCode).toBe(404);
  });
});
