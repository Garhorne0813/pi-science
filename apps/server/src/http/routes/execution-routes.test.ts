import Fastify from "fastify";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const list = await app.inject({
      method: "GET",
      url: `/api/executions?cwd=${encodeURIComponent(cwd)}&session_id=session-route`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().executions).toEqual([
      expect.objectContaining({ execution_id: "exec-route", status: "succeeded" }),
    ]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/executions/exec-route?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(detail.json()).toMatchObject({ correlation: { tool_call_id: "call-route" } });
    const logs = await app.inject({
      method: "GET",
      url: `/api/executions/exec-route/logs?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(logs.json()).toMatchObject({
      stdout: "output",
      stderr: "diagnostic",
      source: "preview",
      complete: false,
    });
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

    const response = await app.inject({
      method: "GET",
      url: `/api/executions/exec-job-route/logs?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(response.json()).toMatchObject({
      stdout: "complete output",
      source: "job",
      complete: true,
    });
  });

  it("rejects invalid filters and unknown executions", async () => {
    const cwd = await workspace();
    const app = Fastify();
    registerExecutionRoutes(app);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/executions?cwd=${encodeURIComponent(cwd)}&kind=nope`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/executions/missing?cwd=${encodeURIComponent(cwd)}`,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("execution history and previews", () => {
  it("paginates beyond 100 records, searches all history, and strictly isolates sessions", async () => {
    const cwd = await workspace();
    // Seed one event log in bulk so the test exercises real persistence without quadratic writes.
    const { writeFile } = await import("node:fs/promises");
    const rows = Array.from({ length: 125 }, (_, index) => ({
      schema_version: 1,
      event_id: `event-${index}`,
      execution_id: `exec-${index}`,
      sequence: 1,
      event_type: "execution.started",
      kind: "tool",
      surface: "pi",
      workspace_id: cwd,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      producer: "test",
      payload: {
        correlation: index === 0 ? {} : { session_id: index % 2 ? "A" : "B" },
        request: { tool: index === 0 ? "oldest-needle" : "read" },
      },
    }));
    await writeFile(
      join(cwd, ".pi-science", "execution-events-v1.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const app = Fastify();
    registerExecutionRoutes(app);
    const get = async (query: string) =>
      (await app.inject(`/api/executions?cwd=${encodeURIComponent(cwd)}&${query}`)).json();
    expect(await get("limit=100")).toMatchObject({
      total: 125,
      filtered_total: 125,
      limit: 100,
      offset: 0,
    });
    const older = await get("limit=100&offset=100");
    expect(older.executions).toHaveLength(25);
    expect(older.executions.at(-1).execution_id).toBe("exec-0");
    const found = await get("search=oldest-needle");
    expect(found).toMatchObject({ total: 125, filtered_total: 1 });
    expect(found.executions[0].execution_id).toBe("exec-0");
    const session = await get("session_id=A");
    expect(session.total).toBe(62);
    expect(
      session.executions.every(
        (run: { correlation: { session_id?: string } }) => run.correlation.session_id === "A",
      ),
    ).toBe(true);
    expect((await get("from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:00Z")).filtered_total).toBe(1);
    expect(await get("target_id=exec-50&limit=50")).toMatchObject({
      target_offset: 50,
      target_in_scope: true,
      target_matches: true,
    });
    expect(await get("target_id=exec-0&limit=50")).toMatchObject({
      target_offset: 100,
      target_in_scope: true,
      target_matches: true,
    });
    expect(await get("target_id=exec-0&session_id=A")).toMatchObject({
      target_offset: null,
      target_in_scope: false,
      target_matches: false,
    });
    expect(await get("target_id=exec-0&kind=job")).toMatchObject({
      target_offset: null,
      target_in_scope: true,
      target_matches: false,
    });
    expect(await get("limit=1")).toMatchObject({
      status_counts: { running: 125 },
      completed_duration_ms: 0,
    });
    expect((await get("kind=job")).filtered_total).toBe(0);
    expect((await get("status=failed")).filtered_total).toBe(0);
    await app.close();
  });

  it("returns tool output alongside stdout, stderr, and errors without claiming completeness", async () => {
    const cwd = await workspace();
    await executionRepository.start(cwd, {
      execution_id: "preview",
      kind: "tool",
      surface: "pi",
      producer: "test",
    });
    await executionRepository.finish(cwd, "preview", {
      status: "failed",
      producer: "test",
      result: {
        output_preview: "tool result",
        stdout_preview: "stdout",
        stderr_preview: "stderr",
        error: "reason",
      },
    });
    const app = Fastify();
    registerExecutionRoutes(app);
    const response = await app.inject(
      `/api/executions/preview/logs?cwd=${encodeURIComponent(cwd)}`,
    );
    expect(response.json()).toMatchObject({
      stdout: "stdout\ntool result",
      stderr: "stderr\nreason",
      source: "preview",
      complete: false,
    });
    await app.close();
  });

  it.each([
    "limit=nope",
    "limit=0",
    "limit=1001",
    "offset=-1",
    "offset=0.5",
    "from=invalid",
    "to=invalid",
    "from=2026-02-01&to=2026-01-01",
  ])("rejects malformed query %s", async (query) => {
    const cwd = await workspace();
    const app = Fastify();
    registerExecutionRoutes(app);
    expect(
      (await app.inject(`/api/executions?cwd=${encodeURIComponent(cwd)}&${query}`)).statusCode,
    ).toBe(400);
    await app.close();
  });
});

it.each(["status=succeeded&limit=1", "limit=1&offset=1", "status=succeeded&prior=failed"])(
  "lists reconciled projections after background recovery: %s",
  async (query) => {
    const cwd = await workspace();
    const { JobCoordinator } = await import("../../runtime/jobs/job-coordinator.js");
    const { writeJsonAtomic } = await import("../../storage/persistence.js");
    const id = "job_1234567890abcdef";
    await executionRepository.start(cwd, {
      execution_id: "stale-job",
      kind: "job",
      surface: "local",
      producer: "test",
      created_at: "2026-01-01T00:00:00Z",
      correlation: { job_id: id },
    });
    if (query.includes("prior=failed"))
      await executionRepository.finish(cwd, "stale-job", {
        status: "failed",
        producer: "test",
        result: { error: "admission failed" },
      });
    await writeJsonAtomic(join(cwd, ".pi-science", "jobs", `${id}.json`), {
      job_id: id,
      execution_id: "stale-job",
      cwd,
      command: ["node"],
      surface: "local",
      status: "succeeded",
      created_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:00:01Z",
      stdout: "done",
      stderr: "",
      artifact_ids: [],
      environment: {},
      requirement: {},
    });
    await executionRepository.start(cwd, {
      execution_id: "newer",
      kind: "tool",
      surface: "pi",
      producer: "test",
      created_at: "2026-02-01T00:00:00Z",
    });
    const jobs = new JobCoordinator();
    const app = Fastify();
    registerExecutionRoutes(app, jobs);
    try {
      // A plain list must not scan Jobs to repair this stale projection.
      const stale = await app.inject(
        `/api/executions?cwd=${encodeURIComponent(cwd)}&status=succeeded`,
      );
      expect(stale.json().executions).toHaveLength(0);
      await jobs.startReconciliation(async () => [cwd]);
      const response = await app.inject(`/api/executions?cwd=${encodeURIComponent(cwd)}&${query}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        executions: [{ execution_id: "stale-job", status: "succeeded" }],
      });
      expect(response.json().executions[0].result.error).toBeUndefined();
    } finally {
      await app.close();
      await jobs.shutdown();
    }
  },
);

it.each(["kind=tool&limit=20", "status=succeeded&limit=20", "limit=20&offset=100"])(
  "does not read historical Jobs for a large list: %s",
  async (queryString) => {
    const cwd = await workspace();
    const { writeFile } = await import("node:fs/promises");
    const { ExecutionRepository } = await import(
      "../../runtime/executions/execution-repository.js"
    );
    const repository = new ExecutionRepository();
    const rows = Array.from({ length: 22000 }, (_, index) => ({
      schema_version: 1,
      event_id: `event-${index}`,
      execution_id: `exec-${index}`,
      sequence: 1,
      event_type: "execution.started",
      kind: index < 20000 ? "job" : "tool",
      surface: "local",
      workspace_id: cwd,
      created_at: new Date(0).toISOString(),
      producer: "test",
      payload: { correlation: index < 20000 ? { job_id: `job-${index}` } : {} },
    }));
    await writeFile(
      join(cwd, ".pi-science", "execution-events-v1.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const query = vi.spyOn(repository, "query");
    // Any Job read would introduce request cost proportional to historical Jobs.
    const get = vi.fn(async () => {
      throw new Error("List must not read Jobs");
    });
    const app = Fastify();
    registerExecutionRoutes(app, { logs: async () => null, get }, repository);
    try {
      const response = await app.inject(
        `/api/executions?cwd=${encodeURIComponent(cwd)}&${queryString}`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().executions).toHaveLength(
        queryString.includes("status=succeeded") ? 0 : 20,
      );
      expect(query).toHaveBeenCalledTimes(1);
      expect(get).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
