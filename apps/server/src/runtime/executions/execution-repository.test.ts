import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionRepository, executionIdFor } from "./execution-repository.js";

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

  it("is idempotent for duplicate starts and terminal updates", async () => {
    const cwd = await workspace();
    const repository = new ExecutionRepository();
    const input = { execution_id: "exec-idempotent", kind: "tool" as const, surface: "pi" as const, producer: "test" };
    await repository.start(cwd, input);
    await repository.start(cwd, input);
    await repository.finish(cwd, input.execution_id, { status: "failed", producer: "test", result: { error: "first" } });
    await repository.finish(cwd, input.execution_id, { status: "succeeded", producer: "test" });
    const events = await repository.events(cwd);
    expect(events).toHaveLength(2);
    expect((await repository.get(cwd, input.execution_id))?.status).toBe("failed");
  });

  it("derives stable ids from source identities", () => {
    expect(executionIdFor("tool", "session", "call")).toBe(executionIdFor("tool", "session", "call"));
    expect(executionIdFor("tool", "session", "call")).not.toBe(executionIdFor("tool", "session", "other"));
  });
});
