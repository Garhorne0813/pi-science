import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScheduledTask, ScheduledTaskRun } from "@pi-science/contracts";
import { ScheduledTaskRepository } from "./repository.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function repository(): Promise<ScheduledTaskRepository> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-scheduled-tasks-"));
  cleanup.push(cwd);
  return new ScheduledTaskRepository(cwd);
}

let sequence = 0;
function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  sequence += 1;
  return {
    task_id: `task-${sequence.toString(16).padStart(16, "0")}`,
    schema_version: 1,
    revision: 0,
    name: `digest ${sequence}`,
    type: "literature_digest",
    enabled: true,
    schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
    executor: { kind: "headless_agent", config: { query: "machine learning" } },
    output: { relative_path: "reports/literature" },
    approval: { status: "none", content_hash: "hash", revision: 0, categories: [], terms: [], updated_at: "2025-01-06T00:00:00.000Z" },
    retry: { max_attempts: 2 },
    next_run_at: "2025-01-06T09:00:00.000Z",
    last_run_at: null,
    created_at: "2025-01-06T00:00:00.000Z",
    updated_at: "2025-01-06T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  sequence += 1;
  return {
    run_id: `run-${sequence.toString(16).padStart(16, "0")}`,
    task_id: "task-0000000000000001",
    scheduled_for: "2025-01-06T09:00:00.000Z",
    trigger: "manual",
    idempotency_key: "task-0000000000000001:2025-01-06T09:00:00.000Z",
    status: "succeeded",
    attempt: 1,
    execution_id: null,
    started_at: "2025-01-06T09:00:00.000Z",
    ended_at: "2025-01-06T09:00:10.000Z",
    output_paths: [],
    error: null,
    usage: { model_tokens: 0, cost_usd: 0 },
    ...overrides,
  };
}

describe("ScheduledTaskRepository", () => {
  it("saves and loads a task from tasks/<task_id>.json", async () => {
    const repo = await repository();
    await repo.saveTask(task());
    const loaded = await repo.getTask("task-0000000000000001");
    expect(loaded).toMatchObject({ task_id: "task-0000000000000001", name: "digest 1", schedule: { cron: "0 9 * * 1-5", timezone: "UTC" } });
    const onDisk = await readFile(join(metadataDir(repo), "tasks", "task-0000000000000001.json"), "utf8");
    expect(JSON.parse(onDisk)).toMatchObject({ schema_version: 1, revision: 0 });
  });

  it("returns null for a missing task or run", async () => {
    const repo = await repository();
    expect(await repo.getTask("task-nope")).toBeNull();
    expect(await repo.getRun("run-nope")).toBeNull();
  });

  it("lists saved tasks sorted by created_at", async () => {
    const repo = await repository();
    const early = task({ task_id: "task-0000000000000002", created_at: "2025-01-05T00:00:00.000Z" });
    const late = task({ task_id: "task-0000000000000003", created_at: "2025-01-07T00:00:00.000Z" });
    await repo.saveTask(late);
    await repo.saveTask(early);
    expect((await repo.listTasks()).map((item) => item.task_id)).toEqual(["task-0000000000000002", "task-0000000000000003"]);
  });

  it("skips a corrupt task file in listTasks", async () => {
    const repo = await repository();
    const good = task({ task_id: "task-0000000000000004" });
    await repo.saveTask(good);
    await writeFile(join(metadataDir(repo), "tasks", "task-0000000000000005.json"), "{ not json", "utf8");
    expect((await repo.listTasks()).map((item) => item.task_id)).toEqual([good.task_id]);
  });

  it("overwrites on save and deletes the task file while keeping runs", async () => {
    const repo = await repository();
    await repo.saveTask(task({ task_id: "task-0000000000000006", name: "first" }));
    await repo.saveTask(task({ task_id: "task-0000000000000006", name: "second" }));
    expect((await repo.getTask("task-0000000000000006"))!.name).toBe("second");
    const saved = run({ task_id: "task-0000000000000006" });
    await repo.saveRun(saved);
    await repo.deleteTask("task-0000000000000006");
    expect(await repo.getTask("task-0000000000000006")).toBeNull();
    expect(await repo.getRun(saved.run_id)).not.toBeNull();
  });

  it("saves a run and fills defaults", async () => {
    const repo = await repository();
    await repo.saveRun({ run_id: "run-0000000000000001", task_id: "task-0000000000000001", scheduled_for: "2025-01-06T09:00:00.000Z", trigger: "cron", idempotency_key: "k:2025-01-06T09:00:00.000Z", status: "pending", attempt: 1 } as unknown as ScheduledTaskRun);
    const loaded = await repo.getRun("run-0000000000000001");
    expect(loaded).toMatchObject({ status: "pending", attempt: 1, execution_id: null, started_at: null, ended_at: null, output_paths: [], error: null, usage: { model_tokens: 0, cost_usd: 0 } });
  });

  it("lists runs newest first, filtered by task and limited", async () => {
    const repo = await repository();
    const other = run({ task_id: "task-9999999999999999", run_id: "run-0000000000000002", scheduled_for: "2025-01-08T09:00:00.000Z" });
    const middle = run({ run_id: "run-0000000000000003", scheduled_for: "2025-01-07T09:00:00.000Z" });
    const newest = run({ run_id: "run-0000000000000004", scheduled_for: "2025-01-08T09:00:00.000Z" });
    const oldest = run({ run_id: "run-0000000000000005", scheduled_for: "2025-01-06T09:00:00.000Z" });
    for (const item of [oldest, other, newest, middle]) await repo.saveRun(item);
    expect((await repo.listRuns("task-0000000000000001", 10)).map((item) => item.run_id)).toEqual(["run-0000000000000004", "run-0000000000000003", "run-0000000000000005"]);
    expect((await repo.listRuns("task-0000000000000001", 2)).map((item) => item.run_id)).toEqual(["run-0000000000000004", "run-0000000000000003"]);
  });

  it("appends run log lines to logs/<run_id>.log", async () => {
    const repo = await repository();
    await repo.appendLog("run-0000000000000001", "first line");
    await repo.appendLog("run-0000000000000001", "second line");
    const log = await readFile(join(metadataDir(repo), "logs", "run-0000000000000001.log"), "utf8");
    expect(log).toBe("first line\nsecond line\n");
    expect(await readdir(join(metadataDir(repo), "logs"))).toEqual(["run-0000000000000001.log"]);
  });
});

function metadataDir(repo: ScheduledTaskRepository): string {
  // .pi-science/scheduled-tasks lives under the workspace root derived from the repo cwd.
  return join(repo.cwd, ".pi-science", "scheduled-tasks");
}
