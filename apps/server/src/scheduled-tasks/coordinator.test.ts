import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScheduledTask, ScheduledTaskRun } from "@pi-science/contracts";
import { ScheduledTaskCoordinator } from "./coordinator.js";
import type { ExecutorKind, ScheduledTaskExecutor } from "./executors.js";
import { ScheduledTaskRepository } from "./repository.js";

const cleanup: string[] = [];
const coordinators: ScheduledTaskCoordinator[] = [];
const originalHome = process.env.PI_SCIENCE_HOME;

afterEach(async () => {
  await Promise.allSettled(coordinators.splice(0).map((coordinator) => coordinator.shutdown()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
});

const MONDAY = Date.UTC(2025, 0, 6, 0, 0, 0); // 2025-01-06T00:00:00Z

type ExecutorResult = { output_paths: string[]; usage: { model_tokens: number; cost_usd: number } };
const DEFAULT_RESULT: ExecutorResult = { output_paths: ["reports/literature/digest.md"], usage: { model_tokens: 10, cost_usd: 0.01 } };

class FakeExecutor implements ScheduledTaskExecutor {
  readonly calls: { task: ScheduledTask; runId: string; logs: string[] }[] = [];
  constructor(private readonly behavior: (call: number, runId: string) => Promise<ExecutorResult> = async () => DEFAULT_RESULT) {}
  async run(task: ScheduledTask, runId: string, ctx: { cwd: string; log: (line: string) => Promise<void> }): Promise<ExecutorResult> {
    const call = this.calls.length;
    this.calls.push({ task, runId, logs: [] });
    const result = await this.behavior(call, runId);
    await ctx.log(`completed ${runId}`);
    this.calls[call]!.logs.push(`completed ${runId}`);
    return result;
  }
}

class HangingExecutor implements ScheduledTaskExecutor {
  readonly pending = new Map<string, (result: ExecutorResult) => void>();
  run(_task: ScheduledTask, runId: string): Promise<ExecutorResult> {
    return new Promise((resolve) => this.pending.set(runId, resolve));
  }
  release(runId: string): void {
    const resolve = this.pending.get(runId);
    if (resolve) { this.pending.delete(runId); resolve(DEFAULT_RESULT); }
  }
}

async function harness(executors: Partial<Record<ExecutorKind, ScheduledTaskExecutor>>, now: () => number = () => MONDAY): Promise<{ cwd: string; repository: ScheduledTaskRepository; coordinator: ScheduledTaskCoordinator }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-scheduled-tasks-"));
  cleanup.push(cwd);
  const home = await mkdtemp(join(tmpdir(), "pi-science-scheduled-tasks-home-"));
  cleanup.push(home);
  process.env.PI_SCIENCE_HOME = home; // isolate the egress audit trail
  const repository = new ScheduledTaskRepository(cwd);
  const coordinator = new ScheduledTaskCoordinator({ cwd, repository, executors, now });
  coordinators.push(coordinator);
  return { cwd, repository, coordinator };
}

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "daily digest",
    type: "literature_digest",
    schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
    executor: { kind: "headless_agent", config: { query: "machine learning", sources: ["arxiv", "pubmed"] } },
    output: { relative_path: "reports/literature/digest.md" },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

describe("ScheduledTaskCoordinator", () => {
  it("creates a task with a computed next_run_at and no approval for clean content", async () => {
    const { coordinator } = await harness({ headless_agent: new FakeExecutor() });
    const task = await coordinator.create(createInput());
    expect(task.task_id).toMatch(/^task-[0-9a-f]{16}$/);
    expect(task.schema_version).toBe(1);
    expect(task.revision).toBe(0);
    expect(task.type).toBe("literature_digest");
    expect(task.approval).toMatchObject({ status: "none", revision: 0, categories: [], terms: [] });
    expect(task.next_run_at).toBe("2025-01-06T09:00:00.000Z");
    expect(task.last_run_at).toBeNull();
    expect(await coordinator.get(task.task_id)).toEqual(task);
    expect((await coordinator.list()).map((item) => item.task_id)).toEqual([task.task_id]);
  });

  it("computes next_run_at in the task timezone", async () => {
    const { coordinator } = await harness({ headless_agent: new FakeExecutor() });
    const task = await coordinator.create(createInput({ schedule: { cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" } }));
    expect(task.next_run_at).toBe("2025-01-06T01:00:00.000Z");
  });

  it("flags sensitive query content: approval pending and next_run_at null", async () => {
    const { coordinator } = await harness({ headless_agent: new FakeExecutor() });
    const task = await coordinator.create(createInput({ executor: { kind: "headless_agent", config: { query: "patient MRN: 2024001234" } } }));
    expect(task.approval.status).toBe("pending");
    expect(task.approval.categories).toEqual(["clinical-identifier"]);
    expect(task.next_run_at).toBeNull();
  });

  it("rejects an invalid cron expression or timezone on create and update", async () => {
    const { coordinator } = await harness({});
    await expect(coordinator.create(createInput({ schedule: { cron: "61 9 * * 1-5", timezone: "UTC" } }))).rejects.toThrow(/invalid cron/);
    await expect(coordinator.create(createInput({ schedule: { cron: "0 9 * * 1-5", timezone: "Not/AZone" } }))).rejects.toThrow(/invalid timezone/);
    await expect(coordinator.create(createInput({ schedule: { cron: "0 9 * * * *", timezone: "UTC" } }))).rejects.toThrow(/expected 5 fields/);
    const task = await coordinator.create(createInput());
    await expect(coordinator.update(task.task_id, { schedule: { cron: "bad" } })).rejects.toThrow(/invalid cron/);
  });

  it("runs a task manually and records success with outputs and usage", async () => {
    const executor = new FakeExecutor();
    const { coordinator } = await harness({ headless_agent: executor });
    const task = await coordinator.create(createInput());
    const run = await coordinator.run(task.task_id, "manual");
    expect(run.status).toBe("succeeded");
    expect(run.trigger).toBe("manual");
    expect(run.attempt).toBe(1);
    expect(run.scheduled_for).toBe("2025-01-06T00:00:00.000Z");
    expect(run.output_paths).toEqual(DEFAULT_RESULT.output_paths);
    expect(run.usage).toEqual(DEFAULT_RESULT.usage);
    expect(run.ended_at).not.toBeNull();
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]!.runId).toBe(run.run_id);
    expect(executor.calls[0]!.logs).toEqual([`completed ${run.run_id}`]);
    const after = await coordinator.get(task.task_id);
    expect(after!.last_run_at).toBe(run.scheduled_for);
    expect(after!.next_run_at).toBe("2025-01-06T09:00:00.000Z"); // future scheduled point untouched
  });

  it("skips a second trigger while a run is in flight", async () => {
    const executor = new HangingExecutor();
    const { coordinator } = await harness({ headless_agent: executor });
    const task = await coordinator.create(createInput());
    const first = coordinator.run(task.task_id, "manual");
    await waitFor(() => executor.pending.size === 1);
    const second = await coordinator.run(task.task_id, "manual");
    expect(second.status).toBe("skipped");
    expect(second.error).toMatch(/in progress/);
    expect(second.trigger).toBe("manual");
    executor.release([...executor.pending.keys()][0]!);
    const done = await first;
    expect(done.status).toBe("succeeded");
    expect(executor.pending.size).toBe(0);
  });

  it("retries a retryable failure and succeeds on the second attempt", async () => {
    const executor = new FakeExecutor(async (call) => {
      if (call === 0) throw new Error("network error: ECONNRESET");
      return DEFAULT_RESULT;
    });
    const { coordinator } = await harness({ headless_agent: executor });
    const task = await coordinator.create(createInput());
    const run = await coordinator.run(task.task_id, "manual");
    expect(run.status).toBe("succeeded");
    expect(run.attempt).toBe(2);
    expect(executor.calls).toHaveLength(2);
  });

  it("marks the run failed when retries are exhausted", async () => {
    const executor = new FakeExecutor(async () => { throw new Error("network error"); });
    const { coordinator } = await harness({ headless_agent: executor });
    const task = await coordinator.create(createInput());
    const run = await coordinator.run(task.task_id, "manual");
    expect(run.status).toBe("failed");
    expect(run.attempt).toBe(2); // default max_attempts = 2
    expect(run.error).toBe("network error");
    expect(run.ended_at).not.toBeNull();
  });

  it("records needs_attention instead of executing when approval is pending", async () => {
    const executor = new FakeExecutor();
    const { coordinator } = await harness({ headless_agent: executor });
    const task = await coordinator.create(createInput({ executor: { kind: "headless_agent", config: { query: "patient MRN: 2024001234" } } }));
    const run = await coordinator.run(task.task_id, "manual");
    expect(run.status).toBe("needs_attention");
    expect(run.error).toMatch(/approval pending/);
    expect(run.started_at).toBeNull();
    expect(executor.calls).toHaveLength(0);
  });

  it("approves a pending task after verifying categories, then runs execute", async () => {
    const executor = new FakeExecutor();
    const { coordinator } = await harness({ headless_agent: executor });
    const task = await coordinator.create(createInput({ executor: { kind: "headless_agent", config: { query: "ACGTACGTACGTACGT" } } }));
    expect(task.approval.status).toBe("pending");
    await expect(coordinator.approve(task.task_id, { categories: ["dna-sequence", "clinical-identifier"] })).rejects.toThrow(/categories mismatch/);
    const approved = await coordinator.approve(task.task_id, { categories: ["dna-sequence"] });
    expect(approved.approval.status).toBe("approved");
    expect(approved.approval.revision).toBe(task.revision);
    expect(approved.approval.content_hash).toBe(task.approval.content_hash);
    expect(approved.next_run_at).toBe("2025-01-06T09:00:00.000Z");
    const audit = await readFile(join(process.env.PI_SCIENCE_HOME!, "egress-audit.jsonl"), "utf8");
    expect(audit).toContain('"connector_type":"scheduled-task"');
    expect(audit).toContain('"approved":true');
    expect(audit).toContain(`"connector_id":"${task.task_id}"`);
    const run = await coordinator.run(task.task_id, "manual");
    expect(run.status).toBe("succeeded");
    expect(executor.calls).toHaveLength(1);
    await expect(coordinator.approve(task.task_id, { categories: ["dna-sequence"] })).rejects.toThrow(/not pending/);
  });

  it("invalidates approval on update when execution content changes, keeps it on name-only edits", async () => {
    const { coordinator } = await harness({ headless_agent: new FakeExecutor() });
    const task = await coordinator.create(createInput({ executor: { kind: "headless_agent", config: { query: "ACGTACGTACGTACGT" } } }));
    await coordinator.approve(task.task_id, { categories: ["dna-sequence"] });
    const renamed = await coordinator.update(task.task_id, { name: "renamed digest" });
    expect(renamed.revision).toBe(1);
    expect(renamed.approval.status).toBe("approved");
    const edited = await coordinator.update(task.task_id, { executor: { kind: "headless_agent", config: { query: "ACGTACGTACGTACGTACGTACGT" } } });
    expect(edited.revision).toBe(2);
    expect(edited.approval.status).toBe("pending");
    expect(edited.next_run_at).toBeNull();
    const cleaned = await coordinator.update(task.task_id, { executor: { kind: "headless_agent", config: { query: "machine learning" } } });
    expect(cleaned.approval.status).toBe("none");
    expect(cleaned.next_run_at).toBe("2025-01-06T09:00:00.000Z");
  });

  it("fails a run whose output path escapes the workspace without retrying", async () => {
    const executor = new FakeExecutor();
    const { coordinator } = await harness({ headless_agent: executor });
    const task = await coordinator.create(createInput({ output: { relative_path: "../escape.md" } }));
    const run = await coordinator.run(task.task_id, "manual");
    expect(run.status).toBe("failed");
    expect(run.attempt).toBe(1);
    expect(run.error).toMatch(/^\[non-retryable\]/);
    expect(run.error).toMatch(/escapes/);
    expect(executor.calls).toHaveLength(0);
  });

  it("fails a run when no executor is registered for the task kind", async () => {
    const { coordinator } = await harness({});
    const task = await coordinator.create(createInput());
    const run = await coordinator.run(task.task_id, "manual");
    expect(run.status).toBe("failed");
    expect(run.attempt).toBe(1);
    expect(run.error).toMatch(/no executor registered/);
    expect(run.error).toMatch(/non-retryable/);
  });

  it("reconciles a missed trigger into a single run and advances the schedule", async () => {
    const executor = new FakeExecutor();
    let nowMs = MONDAY;
    const { coordinator, repository } = await harness({ headless_agent: executor }, () => nowMs);
    const task = await coordinator.create(createInput());
    nowMs = Date.UTC(2025, 0, 7, 12, 0, 0); // Tuesday noon: Monday 09:00 was missed
    await coordinator.reconcile();
    const runs = await repository.listRuns(task.task_id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("reconcile");
    expect(runs[0]!.scheduled_for).toBe("2025-01-06T09:00:00.000Z");
    expect(runs[0]!.status).toBe("succeeded");
    expect(executor.calls).toHaveLength(1);
    const after = await coordinator.get(task.task_id);
    expect(after!.last_run_at).toBe("2025-01-06T09:00:00.000Z");
    expect(after!.next_run_at).toBe("2025-01-08T09:00:00.000Z"); // Wednesday 09:00 UTC
  });

  it("tick triggers due cron tasks and re-executes stale pending runs", async () => {
    const executor = new FakeExecutor();
    let nowMs = MONDAY;
    const { coordinator, repository } = await harness({ headless_agent: executor }, () => nowMs);
    const task = await coordinator.create(createInput());
    nowMs = Date.UTC(2025, 0, 6, 9, 0, 1); // just past the scheduled point
    await coordinator.tick();
    const runs = await repository.listRuns(task.task_id, 10);
    expect(runs.map((item) => item.status)).toEqual(["succeeded"]);
    expect(runs[0]!.trigger).toBe("cron");
    expect(runs[0]!.scheduled_for).toBe("2025-01-06T09:00:00.000Z");
    expect((await coordinator.get(task.task_id))!.next_run_at).toBe("2025-01-07T09:00:00.000Z");
    expect(coordinator.lastTickAt).toBe(nowMs);

    // A pending run left by a crashed process is re-executed by the next tick.
    const stale: ScheduledTaskRun = {
      run_id: "run-0000000000000001", task_id: task.task_id, scheduled_for: "2025-01-07T09:00:00.000Z",
      trigger: "cron", idempotency_key: `${task.task_id}:2025-01-07T09:00:00.000Z`, status: "pending",
      attempt: 0, execution_id: null, started_at: null, ended_at: null, output_paths: [], error: null,
      usage: { model_tokens: 0, cost_usd: 0 },
    };
    await repository.saveRun(stale);
    await coordinator.tick();
    const recovered = await repository.getRun(stale.run_id);
    expect(recovered!.status).toBe("succeeded");
    expect(recovered!.attempt).toBe(1);
    expect(executor.calls).toHaveLength(2);
  });

  it("deletes a task but keeps its run history", async () => {
    const executor = new FakeExecutor();
    const { coordinator, repository } = await harness({ headless_agent: executor });
    const task = await coordinator.create(createInput());
    await coordinator.run(task.task_id, "manual");
    await coordinator.delete(task.task_id);
    expect(await coordinator.get(task.task_id)).toBeNull();
    expect(await repository.listRuns(task.task_id, 10)).toHaveLength(1);
    await expect(coordinator.delete(task.task_id)).rejects.toThrow(/not found/);
  });

  it("previews the next 5 runs with the authoritative schedule computation", async () => {
    const { coordinator } = await harness({}); // fake now = 2025-01-06T00:00:00Z (Monday)
    const preview = coordinator.preview({ cron: "0 9 * * 1-5", timezone: "UTC" });
    expect(preview).toEqual({
      valid: true,
      error: null,
      timezone: "UTC",
      next_runs: [
        "2025-01-06T09:00:00.000Z",
        "2025-01-07T09:00:00.000Z",
        "2025-01-08T09:00:00.000Z",
        "2025-01-09T09:00:00.000Z",
        "2025-01-10T09:00:00.000Z",
      ],
    });
  });

  it("previews in the task timezone and for minute-level schedules", async () => {
    const { coordinator } = await harness({});
    const shifted = coordinator.preview({ cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" });
    expect(shifted.valid).toBe(true);
    expect(shifted.next_runs[0]).toBe("2025-01-06T01:00:00.000Z");
    const everyMinute = coordinator.preview({ cron: "* * * * *", timezone: "UTC" });
    expect(everyMinute.valid).toBe(true);
    expect(everyMinute.next_runs).toEqual([
      "2025-01-06T00:01:00.000Z",
      "2025-01-06T00:02:00.000Z",
      "2025-01-06T00:03:00.000Z",
      "2025-01-06T00:04:00.000Z",
      "2025-01-06T00:05:00.000Z",
    ]);
  });

  it("preview rejects an invalid timezone and an invalid cron with readable errors", async () => {
    const { coordinator } = await harness({});
    expect(coordinator.preview({ cron: "0 9 * * 1-5", timezone: "Not/AZone" })).toEqual({
      valid: false,
      error: "无效时区: Not/AZone",
      timezone: "Not/AZone",
      next_runs: [],
    });
    const badCron = coordinator.preview({ cron: "99 9 * * 1-5", timezone: "UTC" });
    expect(badCron.valid).toBe(false);
    expect(badCron.error).toMatch(/无效 cron 表达式/);
    expect(badCron.error).toMatch(/Constraint error/);
    expect(badCron.next_runs).toEqual([]);
    const sixFields = coordinator.preview({ cron: "0 9 * * * *", timezone: "UTC" });
    expect(sixFields.valid).toBe(false);
    expect(sixFields.error).toMatch(/expected 5 fields/);
    const feb31 = coordinator.preview({ cron: "0 0 31 2 *", timezone: "UTC" });
    expect(feb31.valid).toBe(false);
    expect(feb31.error).toMatch(/Invalid explicit day of month/);
  });

  it("preview handles month-day boundaries: leap-day runs span years, invalid day combos fail", async () => {
    const { coordinator } = await harness({});
    const leapDay = coordinator.preview({ cron: "0 0 29 2 *", timezone: "UTC" });
    expect(leapDay.valid).toBe(true);
    expect(leapDay.next_runs).toEqual([
      "2028-02-29T00:00:00.000Z",
      "2032-02-29T00:00:00.000Z",
      "2036-02-29T00:00:00.000Z",
      "2040-02-29T00:00:00.000Z",
      "2044-02-29T00:00:00.000Z",
    ]);
    const sunday = coordinator.preview({ cron: "0 9 * * 7", timezone: "UTC" });
    expect(sunday.valid).toBe(true);
    expect(sunday.next_runs[0]).toBe("2025-01-12T09:00:00.000Z");
  });
});
