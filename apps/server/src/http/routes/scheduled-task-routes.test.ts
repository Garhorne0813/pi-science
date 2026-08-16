import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScheduledTask } from "@pi-science/contracts";
import { ScheduledTaskCoordinatorManager } from "../../scheduled-tasks/coordinator-manager.js";
import type { ScheduledTaskExecutor } from "../../scheduled-tasks/executors.js";
import { registerScheduledTaskRoutes } from "./scheduled-task-routes.js";

const cleanup: string[] = [];
const apps: FastifyInstance[] = [];
const managers: ScheduledTaskCoordinatorManager[] = [];
let auditDir = "";
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.PI_SCIENCE_HOME;
  auditDir = "";
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
});

class FakeExecutor implements ScheduledTaskExecutor {
  readonly calls: string[] = [];
  async run(_task: ScheduledTask, runId: string, ctx: { cwd: string; log: (line: string) => Promise<void> }): Promise<{ output_paths: string[]; usage: { model_tokens: number; cost_usd: number } }> {
    this.calls.push(runId);
    await ctx.log("x".repeat(9000));
    await ctx.log(`completed ${runId}`);
    return { output_paths: [`reports/literature/${runId}.md`], usage: { model_tokens: 7, cost_usd: 0.002 } };
  }
}

async function harness(): Promise<{ cwd: string; app: FastifyInstance; executor: FakeExecutor; manager: ScheduledTaskCoordinatorManager }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-routes-"));
  cleanup.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true }); // workspace marker required by validateWorkspaceCwd
  auditDir = await mkdtemp(join(tmpdir(), "pi-science-routes-audit-"));
  cleanup.push(auditDir);
  process.env.PI_SCIENCE_HOME = auditDir; // isolate egress audit writes
  const executor = new FakeExecutor();
  const manager = new ScheduledTaskCoordinatorManager({ headless_agent: executor });
  managers.push(manager);
  const app = Fastify();
  registerScheduledTaskRoutes(app, manager);
  apps.push(app);
  return { cwd, app, executor, manager };
}

const createPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "daily digest",
  type: "literature_digest",
  schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
  executor: { kind: "headless_agent", config: { query: "machine learning", providers: ["arxiv"] } },
  output: { relative_path: "reports/literature" },
  ...overrides,
});

describe("scheduled task routes", () => {
  it("creates, lists, gets, updates and deletes a task", async () => {
    const { cwd, app } = await harness();
    const created = await app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(cwd)}`, payload: createPayload() });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    expect(task.task_id).toMatch(/^task-/);
    expect(task.approval.status).toBe("none");

    const listed = await app.inject({ method: "GET", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(cwd)}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().tasks.map((item: { task_id: string }) => item.task_id)).toEqual([task.task_id]);

    const got = await app.inject({ method: "GET", url: `/api/scheduled-tasks/${task.task_id}?cwd=${encodeURIComponent(cwd)}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().name).toBe("daily digest");

    const patched = await app.inject({ method: "PATCH", url: `/api/scheduled-tasks/${task.task_id}?cwd=${encodeURIComponent(cwd)}`, payload: { name: "renamed" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "renamed", revision: 1 });

    const deleted = await app.inject({ method: "DELETE", url: `/api/scheduled-tasks/${task.task_id}?cwd=${encodeURIComponent(cwd)}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });

    const missing = await app.inject({ method: "GET", url: `/api/scheduled-tasks/${task.task_id}?cwd=${encodeURIComponent(cwd)}` });
    expect(missing.statusCode).toBe(404);
  });

  it("returns 400 for invalid create payloads and 404 for unknown task ids", async () => {
    const { cwd, app } = await harness();
    const bad = await app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(cwd)}`, payload: createPayload({ schedule: { cron: "bad cron", timezone: "UTC" } }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/cron/);
    const noName = await app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(cwd)}`, payload: createPayload({ name: "" }) });
    expect(noName.statusCode).toBe(400);
    const unknown = await app.inject({ method: "GET", url: `/api/scheduled-tasks/task-nope?cwd=${encodeURIComponent(cwd)}` });
    expect(unknown.statusCode).toBe(404);
    const deleteUnknown = await app.inject({ method: "DELETE", url: `/api/scheduled-tasks/task-nope?cwd=${encodeURIComponent(cwd)}` });
    expect(deleteUnknown.statusCode).toBe(404);
  });

  it("rejects a cwd that is not a registered workspace with 403", async () => {
    const { app } = await harness();
    const response = await app.inject({ method: "GET", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(join(tmpdir(), "not-a-workspace-xyz"))}` });
    expect(response.statusCode).toBe(403);
  });

  it("runs a task manually through the executor and lists runs with a log tail", async () => {
    const { cwd, app, executor } = await harness();
    const created = await app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(cwd)}`, payload: createPayload() });
    const taskId = created.json().task_id as string;

    const run = await app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/run?cwd=${encodeURIComponent(cwd)}` });
    expect(run.statusCode).toBe(200);
    const runRecord = run.json();
    expect(runRecord.status).toBe("succeeded");
    expect(runRecord.trigger).toBe("manual");
    expect(runRecord.usage).toEqual({ model_tokens: 7, cost_usd: 0.002 });
    expect(executor.calls).toEqual([runRecord.run_id]);

    const runs = await app.inject({ method: "GET", url: `/api/scheduled-tasks/${taskId}/runs?cwd=${encodeURIComponent(cwd)}` });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().runs).toHaveLength(1);

    const detail = await app.inject({ method: "GET", url: `/api/scheduled-tasks/${taskId}/runs/${runRecord.run_id}?cwd=${encodeURIComponent(cwd)}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.run_id).toBe(runRecord.run_id);
    expect(body.log_tail).toBeDefined();
    expect(body.log_tail.length).toBe(8000); // truncated to the tail window
    expect(body.log_tail.endsWith(`completed ${runRecord.run_id}\n`)).toBe(true);

    const unknownRun = await app.inject({ method: "GET", url: `/api/scheduled-tasks/${taskId}/runs/run-nope?cwd=${encodeURIComponent(cwd)}` });
    expect(unknownRun.statusCode).toBe(404);
    const unknownRuns = await app.inject({ method: "GET", url: `/api/scheduled-tasks/task-nope/runs?cwd=${encodeURIComponent(cwd)}` });
    expect(unknownRuns.statusCode).toBe(404);
  });

  it("approves a sensitive task with matching categories and rejects mismatches", async () => {
    const { cwd, app } = await harness();
    const created = await app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(cwd)}`, payload: createPayload({ executor: { kind: "headless_agent", config: { query: "ACGTACGTACGTACGT" } } }) });
    const taskId = created.json().task_id as string;
    expect(created.json().approval.status).toBe("pending");

    const wrong = await app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/approve?cwd=${encodeURIComponent(cwd)}`, payload: { categories: ["clinical-identifier"] } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toMatch(/categories mismatch/);

    const right = await app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/approve?cwd=${encodeURIComponent(cwd)}`, payload: { categories: ["dna-sequence"] } });
    expect(right.statusCode).toBe(200);
    expect(right.json().approval.status).toBe("approved");

    const empty = await app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/approve?cwd=${encodeURIComponent(cwd)}`, payload: {} });
    expect(empty.statusCode).toBe(400); // pending approval with detected categories must match them

    const none = await app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/approve?cwd=${encodeURIComponent(cwd)}` });
    expect(none.statusCode).toBe(400); // no body → categories default to []
  });
});
