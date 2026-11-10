import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionRepository, executionIdFor } from "./execution-repository.js";
import { subscribeExecutionEvents } from "./execution-events.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-science-executions-"));
  workspaces.push(path);
  return path;
}

describe("ExecutionRepository", () => {
  it("reduces a lifecycle into one queryable execution", async () => {
    const cwd = await workspace();
    const repository = new ExecutionRepository();
    const started = await repository.start(cwd, {
      execution_id: "exec-test",
      kind: "job",
      surface: "local",
      producer: "test",
      correlation: { job_id: "job-1", session_id: "session-1" },
      request: { command: ["python", "analysis.py"] },
    });
    expect(started.status).toBe("running");

    const finished = await repository.finish(cwd, started.execution_id, {
      status: "succeeded",
      producer: "test",
      result: { exit_code: 0, stdout_preview: "done" },
      files: { written: [{ path: "results/out.csv", detection: "snapshot" }] },
    });
    expect(finished).toMatchObject({
      execution_id: "exec-test",
      status: "succeeded",
      correlation: { job_id: "job-1", session_id: "session-1" },
      result: { exit_code: 0, stdout_preview: "done" },
    });
    expect(finished?.files.written).toEqual([{ path: "results/out.csv", detection: "snapshot" }]);
    await expect(repository.list(cwd, { session_id: "session-1" })).resolves.toHaveLength(1);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "lost"] as const)(
    "reads retired sandbox_run %s evidence without an executor or replay",
    async (status) => {
      const cwd = await workspace();
      const repository = new ExecutionRepository();
      const execution_id = executionIdFor(
        "sandbox_run",
        "historical-session",
        "historical-operation",
        "historical-call",
      );
      const request = {
        candidate_id: "candidate-001",
        research_id: "study-1",
        code: "print('historical')",
        code_sha256: "historical-code-digest",
        timeout_seconds: 60,
      };
      const result = {
        execution_id,
        status,
        stdout: "historical output\n",
        stderr: "historical diagnostic",
        artifact_refs: [{ artifact_id: "historical-artifact", version: 2, relation: "output" }],
      };
      await repository.start(cwd, {
        execution_id,
        kind: "tool",
        surface: "python",
        producer: "sandbox_run",
        request,
      });
      await repository.finish(cwd, execution_id, {
        status,
        producer: "sandbox_run",
        result,
        artifacts: [{ artifact_id: "historical-artifact", version: 2, relation: "output" }],
      });
      const events = await repository.events(cwd);
      const reopened = new ExecutionRepository();
      expect(await reopened.get(cwd, execution_id)).toMatchObject({
        producer: "sandbox_run",
        status,
        request,
        result,
        artifacts: [{ artifact_id: "historical-artifact", version: 2, relation: "output" }],
      });
      expect(await reopened.list(cwd)).toHaveLength(1);
      expect(await reopened.events(cwd)).toEqual(events);
    },
  );

  it("is idempotent for duplicate starts and terminal updates", async () => {
    const cwd = await workspace();
    const repository = new ExecutionRepository();
    const input = {
      execution_id: "exec-idempotent",
      kind: "tool" as const,
      surface: "pi" as const,
      producer: "test",
    };
    await repository.start(cwd, input);
    await repository.start(cwd, input);
    await repository.finish(cwd, input.execution_id, {
      status: "failed",
      producer: "test",
      result: { error: "first" },
    });
    await repository.finish(cwd, input.execution_id, { status: "succeeded", producer: "test" });
    const events = await repository.events(cwd);
    expect(events).toHaveLength(2);
    expect((await repository.get(cwd, input.execution_id))?.status).toBe("failed");
  });

  it("derives stable ids from source identities", () => {
    expect(executionIdFor("tool", "session", "call")).toBe(
      executionIdFor("tool", "session", "call"),
    );
    expect(executionIdFor("tool", "session", "call")).not.toBe(
      executionIdFor("tool", "session", "other"),
    );
  });

  it("notifies workspace subscribers only after a new event is persisted", async () => {
    const cwd = await workspace();
    const repository = new ExecutionRepository();
    const received: string[] = [];
    const unsubscribe = subscribeExecutionEvents(cwd, (event) => received.push(event.event_type));

    const input = {
      execution_id: "exec-live",
      kind: "tool" as const,
      surface: "pi" as const,
      producer: "test",
    };
    await repository.start(cwd, input);
    await repository.start(cwd, input);
    await repository.finish(cwd, input.execution_id, { status: "succeeded", producer: "test" });
    await repository.finish(cwd, input.execution_id, {
      status: "failed",
      producer: "test",
      result: { error: "admission failed", stderr_preview: "old error" },
    });

    expect(received).toEqual(["execution.started", "execution.completed"]);
    unsubscribe();
  });
});

it("reuses unchanged materializations and invalidates appends and external edits", async () => {
  const cwd = await workspace();
  const repository = new ExecutionRepository();
  const { vi } = await import("vitest");
  const events = vi.spyOn(repository, "events");
  await repository.start(cwd, {
    execution_id: "cache",
    kind: "tool",
    surface: "pi",
    producer: "test",
  });
  await repository.query(cwd);
  const reads = events.mock.calls.length;
  const record = await repository.get(cwd, "cache");
  record!.request.tool = "mutation";
  expect((await repository.get(cwd, "cache"))!.request.tool).toBeUndefined();
  await repository.query(cwd);
  expect(events.mock.calls.length).toBe(reads);
  await repository.finish(cwd, "cache", { status: "succeeded", producer: "test" });
  expect((await repository.query(cwd)).executions[0]!.status).toBe("succeeded");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(cwd, ".pi-science", "execution-events-v1.jsonl"), "");
  expect((await repository.query(cwd)).total).toBe(0);
});

describe("execution time window intersection", () => {
  it("includes long executions crossing a window and inclusive edges", async () => {
    const { executionOverlapsWindow } = await import("./execution-repository.js");
    const from = "2026-10-13T10:00:00Z",
      to = "2026-10-13T11:00:00Z";
    expect(
      executionOverlapsWindow(
        {
          status: "succeeded",
          started_at: "2026-10-13T09:00:00Z",
          ended_at: "2026-10-13T12:00:00Z",
        },
        from,
        to,
      ),
    ).toBe(true);
    expect(
      executionOverlapsWindow(
        { status: "succeeded", started_at: "2026-10-13T09:00:00Z", ended_at: from },
        from,
        to,
      ),
    ).toBe(true);
    expect(
      executionOverlapsWindow(
        { status: "succeeded", started_at: to, ended_at: "2026-10-13T12:00:00Z" },
        from,
        to,
      ),
    ).toBe(true);
    expect(
      executionOverlapsWindow(
        {
          status: "succeeded",
          started_at: "2026-10-13T09:00:00Z",
          ended_at: "2026-10-13T09:59:59Z",
        },
        from,
        to,
      ),
    ).toBe(false);
  });
  it("uses now for running executions and does not invent missing or invalid intervals", async () => {
    const { executionOverlapsWindow } = await import("./execution-repository.js");
    const from = "2026-10-13T10:00:00Z",
      to = "2026-10-13T11:00:00Z",
      now = Date.parse(to);
    expect(
      executionOverlapsWindow(
        { status: "running", started_at: "2026-10-13T09:00:00Z" },
        from,
        to,
        now,
      ),
    ).toBe(true);
    expect(executionOverlapsWindow({ status: "succeeded", started_at: from }, from, to, now)).toBe(
      true,
    );
    expect(executionOverlapsWindow({ status: "succeeded" }, from, to, now)).toBe(false);
    expect(
      executionOverlapsWindow({ status: "running", started_at: "invalid" }, from, to, now),
    ).toBe(false);
    expect(
      executionOverlapsWindow(
        { status: "succeeded", started_at: to, ended_at: from },
        from,
        to,
        now,
      ),
    ).toBe(false);
  });
});

it("updates its write index without rereading history and invalidates on another writer", async () => {
  const cwd = await workspace();
  const repository = new ExecutionRepository();
  const reads = vi.spyOn(repository, "events");
  const input = { kind: "job" as const, surface: "local" as const, producer: "test" };
  for (let i = 0; i < 20; i++) {
    const record = await repository.start(cwd, { ...input, execution_id: `indexed-${i}` });
    await repository.finish(cwd, record.execution_id, { producer: "test", status: "succeeded" });
  }
  expect(reads).toHaveBeenCalledTimes(1);
  const other = new ExecutionRepository();
  await other.start(cwd, { ...input, execution_id: "external" });
  expect((await repository.list(cwd, { limit: 100 })).length).toBe(21);
  expect(reads).toHaveBeenCalledTimes(2);
  await repository.finish(cwd, "external", { producer: "test", status: "failed" });
  expect((await other.get(cwd, "external"))?.status).toBe("failed");
});

it("lets only the authoritative job repair an earlier terminal projection", async () => {
  const cwd = await workspace();
  const repository = new ExecutionRepository();
  const input = {
    execution_id: "job-repair",
    kind: "job" as const,
    surface: "local" as const,
    producer: "test",
    correlation: { job_id: "job-authority" },
  };
  await repository.start(cwd, input);
  await repository.finish(cwd, input.execution_id, {
    status: "failed",
    producer: "test",
    result: { error: "admission failed", stderr_preview: "old error" },
  });
  expect(
    (
      await repository.finish(cwd, input.execution_id, {
        status: "succeeded",
        producer: "test",
        authoritative_job_id: "wrong-job",
      })
    )?.status,
  ).toBe("failed");
  expect(
    (
      await repository.finish(cwd, input.execution_id, {
        status: "succeeded",
        producer: "test",
        authoritative_job_id: "job-authority",
        result: { exit_code: 0, stdout_preview: "done" },
      })
    )?.status,
  ).toBe("succeeded");
  await repository.finish(cwd, input.execution_id, {
    status: "succeeded",
    producer: "test",
    authoritative_job_id: "job-authority",
  });
  expect(await repository.events(cwd)).toHaveLength(3);
  expect((await repository.get(cwd, input.execution_id))?.result).toEqual({
    exit_code: 0,
    stdout_preview: "done",
  });
  expect((await new ExecutionRepository().get(cwd, input.execution_id))?.result).toEqual({
    exit_code: 0,
    stdout_preview: "done",
  });
});
