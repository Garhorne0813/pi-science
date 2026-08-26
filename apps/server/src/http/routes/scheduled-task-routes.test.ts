// Phase 6 HTTP route tests (docs §12, §14.2): Fastify inject coverage for
// 201/202/400/403/404/409/422/503, expected_revision conflicts, pagination
// cursors, cross-workspace 404s and the manual-run Location contract.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerScheduledTaskRoutes } from "./scheduled-task-routes.js";
import { ScheduledTaskRepository } from "../../storage/sqlite/repositories/scheduled-task-repository.js";
import { WorkspaceRepository } from "../../storage/sqlite/repositories/workspace-repository.js";
import { InMemorySqliteStateStore } from "../../storage/sqlite/state-store.js";
import { ScheduledTaskService } from "../../scheduled-tasks/service.js";
import { computeApprovalScopeHash } from "../../scheduled-tasks/approval.js";

const stores: InMemorySqliteStateStore[] = [];
const directories: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["PI_SCIENCE_SCHEDULED_TASKS", "PI_SCIENCE_WORKSPACES", "PI_SCIENCE_SENSITIVE_TERMS"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Harness {
  app: FastifyInstance;
  store: InMemorySqliteStateStore;
  repository: ScheduledTaskRepository;
  wsA: string;
  wsB: string;
  plainDir: string;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

/** options.plainWorkspaces skips registration so guards can be tested without touching SQLite. */
async function harness(options: { flag?: boolean; sqlite?: boolean; startStore?: boolean; plainWorkspaces?: boolean } = {}): Promise<Harness> {
  process.env.PI_SCIENCE_SCHEDULED_TASKS = options.flag === false ? "0" : "1";
  const store = new InMemorySqliteStateStore();
  stores.push(store);
  if (options.startStore !== false) await store.start();
  const workspaces = new WorkspaceRepository(store);
  const repository = new ScheduledTaskRepository(store);
  const service = new ScheduledTaskService({ repository, workspaces });
  const app = Fastify();
  registerScheduledTaskRoutes(app, { service, sqliteEnabled: options.sqlite !== false, stateStore: store });
  const rawA = await tempDir("stask-ws-a-");
  const rawB = await tempDir("stask-ws-b-");
  if (options.plainWorkspaces !== true) {
    // ensureProject writes the .pi-science marker; remember registers the row.
    await workspaces.rememberWorkspace(rawA);
    await workspaces.rememberWorkspace(rawB);
  }
  // Mirror validateWorkspaceCwd's realpath so URL-built expectations match.
  const [wsA, wsB] = await Promise.all([realpath(rawA), realpath(rawB)]);
  return { app, store, repository, wsA, wsB, plainDir: await tempDir("stask-plain-") };
}

const SCHEDULE = { type: "interval", every_seconds: 3600, anchor_at: "2026-01-01T00:00:00Z", timezone: "UTC" };
const EXECUTOR = { kind: "literature_digest" as const, config: { query: "single-cell RNA sequencing quality control", providers: ["pubmed" as const], max_results: 30, language: "zh-CN" as const } };

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Daily digest",
    schedule: SCHEDULE,
    executor: EXECUTOR,
    output: { relative_root: "outputs/digest" },
    retry: { max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 },
    budget: { max_wall_time_seconds: 900 },
    ...overrides,
  };
}

describe("scheduled task routes", () => {
  it("creates, reads and lists tasks through the typed API", async () => {
    const h = await harness();
    const created = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody() });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ task_id: expect.stringMatching(/^stask_/), revision: 1, lifecycle_status: "active", approval: { status: "none" } });

    const got = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks/${created.json().task_id}?cwd=${encodeURIComponent(h.wsA)}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().task_id).toBe(created.json().task_id);

    const listed = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ items: [expect.objectContaining({ task_id: created.json().task_id, latest_run: null })], next_cursor: null });
  });

  it("answers manual runs with 202 and a resolvable Location (docs §12.4)", async () => {
    const h = await harness();
    const created = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody() });
    const taskId = created.json().task_id;
    const run = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/run?cwd=${encodeURIComponent(h.wsA)}` });
    expect(run.statusCode).toBe(202);
    expect(run.headers.location).toBe(`/api/scheduled-tasks/${taskId}/runs/${run.json().run.run_id}?cwd=${encodeURIComponent(h.wsA)}`);
    expect(run.json().run).toMatchObject({
      run_id: run.json().run.run_id,
      task_id: taskId,
      status: "pending",
      trigger_source: "manual",
      latest_attempt: { attempt_id: expect.stringMatching(/^satt_/), attempt_no: 1, status: "pending", execution_id: expect.stringMatching(/^exec_/) },
    });
    const located = await h.app.inject({ method: "GET", url: String(run.headers.location) });
    expect(located.statusCode).toBe(200);
    expect(located.json()).toMatchObject({ run_id: run.json().run.run_id, status: "pending" });
  });

  it("maps invalid schedules and timezones to 400 codes", async () => {
    const h = await harness();
    const badCron = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody({ schedule: { type: "cron", expression: "0 9 * * * *", timezone: "UTC" } }) });
    expect(badCron.statusCode).toBe(400);
    expect(badCron.json().code).toBe("INVALID_SCHEDULE");
    const badZone = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody({ schedule: { type: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" } }) });
    expect(badZone.statusCode).toBe(400);
    expect(badZone.json().code).toBe("INVALID_TIMEZONE");
    expect(badZone.json()).toMatchObject({ request_id: expect.any(String), details: { timezone: "Mars/Olympus" } });
  });

  it("rejects unregistered workspace paths with 403 WORKSPACE_FORBIDDEN", async () => {
    const h = await harness();
    const response = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.plainDir)}` });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("WORKSPACE_FORBIDDEN");
  });

  it("hides cross-workspace ids behind 404 without leaking existence (docs §10.1/§12.8)", async () => {
    const h = await harness();
    const createdA = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody() });
    const createdB = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsB)}`, payload: createBody() });
    const idA = createdA.json().task_id;
    const idB = createdB.json().task_id;

    const crossTask = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks/${idA}?cwd=${encodeURIComponent(h.wsB)}` });
    expect(crossTask.statusCode).toBe(404);
    expect(crossTask.json().code).toBe("SCHEDULED_TASK_NOT_FOUND");

    const missing = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks/stask_missing?cwd=${encodeURIComponent(h.wsA)}` });
    expect(missing.statusCode).toBe(404);

    const runB = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${idB}/run?cwd=${encodeURIComponent(h.wsB)}` });
    expect(runB.statusCode).toBe(202);
    const runIdB = runB.json().run.run_id;
    const crossRun = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks/${idA}/runs/${runIdB}?cwd=${encodeURIComponent(h.wsA)}` });
    expect(crossRun.statusCode).toBe(404);
    expect(crossRun.json().code).toBe("SCHEDULED_TASK_RUN_NOT_FOUND");
    // Same-workspace but wrong task container is equally a 404.
    const wrongContainer = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks/${idA}/runs/${runIdB}?cwd=${encodeURIComponent(h.wsB)}` });
    expect(wrongContainer.statusCode).toBe(404);
  });

  it("returns both 409 flavors: revision conflict and approval scope change", async () => {
    const h = await harness();
    const created = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody() });
    const taskId = created.json().task_id;

    const conflict = await h.app.inject({ method: "PATCH", url: `/api/scheduled-tasks/${taskId}?cwd=${encodeURIComponent(h.wsA)}`, payload: { expected_revision: 99, patch: { name: "Renamed" } } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("SCHEDULED_TASK_REVISION_CONFLICT");
    expect(conflict.json().details).toMatchObject({ expected_revision: 99, actual_revision: 1 });

    // Sensitive query → durable pending gate; wrong hash → APPROVAL_SCOPE_CHANGED.
    const sensitiveExecutor = { kind: "literature_digest" as const, config: { query: "patient MRN 8812345 cohort GATTACAGATTACA", providers: ["pubmed" as const], max_results: 30, language: "zh-CN" as const } };
    const sensitive = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody({ executor: sensitiveExecutor, output: { relative_root: "outputs/sensitive" } }) });
    expect(sensitive.json().approval.status).toBe("pending");
    const sensitiveId = sensitive.json().task_id;
    const wrongHash = await h.app.inject({
      method: "POST",
      url: `/api/scheduled-tasks/${sensitiveId}/approve?cwd=${encodeURIComponent(h.wsA)}`,
      payload: { expected_revision: 1, approval_scope_hash: "sha256_wrong", categories: ["clinical-identifier"] },
    });
    expect(wrongHash.statusCode).toBe(409);
    expect(wrongHash.json().code).toBe("SCHEDULED_TASK_APPROVAL_SCOPE_CHANGED");

    const rightHash = computeApprovalScopeHash(sensitiveExecutor, "outputs/sensitive");
    const approved = await h.app.inject({
      method: "POST",
      url: `/api/scheduled-tasks/${sensitiveId}/approve?cwd=${encodeURIComponent(h.wsA)}`,
      payload: { expected_revision: 1, approval_scope_hash: rightHash, categories: ["clinical-identifier", "dna-sequence"] },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().approval.status).toBe("approved");

    // Third 409 flavor: manual run before approval is required first.
    const pendingAgain = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody({ executor: sensitiveExecutor, output: { relative_root: "outputs/pending2" }, name: "Second" }) });
    const gatedRun = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${pendingAgain.json().task_id}/run?cwd=${encodeURIComponent(h.wsA)}` });
    expect(gatedRun.statusCode).toBe(409);
    expect(gatedRun.json().code).toBe("SCHEDULED_TASK_APPROVAL_REQUIRED");
  });

  it("maps sub-minimum frequency to 422 SCHEDULED_TASK_POLICY_VIOLATION", async () => {
    const h = await harness();
    // A per-minute cron clears the wire-level schema but violates the docs §15.5 minimum frequency.
    const response = await h.app.inject({
      method: "POST",
      url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`,
      payload: createBody({ schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("SCHEDULED_TASK_POLICY_VIOLATION");
  });

  it("paginates tasks with opaque cursors and rejects invalid ones", async () => {
    const h = await harness();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody({ name: `Task ${index}` }) });
      ids.push(created.json().task_id);
    }
    const page1 = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}&limit=2` });
    expect(page1.json().items.map((item: { task_id: string }) => item.task_id)).toHaveLength(2);
    expect(typeof page1.json().next_cursor).toBe("string");
    const page2 = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}&limit=2&cursor=${encodeURIComponent(page1.json().next_cursor)}` });
    expect(page2.json().items.map((item: { task_id: string }) => item.task_id)).toEqual([ids[0]]);
    expect(page2.json().next_cursor).toBeNull();

    const invalidCursor = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}&cursor=%21%21%21` });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json().code).toBe("INVALID_CURSOR");

    const created = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody() });
    const run = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${created.json().task_id}/run?cwd=${encodeURIComponent(h.wsA)}` });
    const invalidAttemptCursor = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks/${created.json().task_id}/runs/${run.json().run.run_id}/attempts?cwd=${encodeURIComponent(h.wsA)}&cursor=zz` });
    expect(invalidAttemptCursor.statusCode).toBe(400);
    expect(invalidAttemptCursor.json().code).toBe("INVALID_CURSOR");
  });

  it("covers pause/resume/delete with expected_revision CAS", async () => {
    const h = await harness();
    const created = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody() });
    const taskId = created.json().task_id;
    const cwd = encodeURIComponent(h.wsA);

    const paused = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/pause?cwd=${cwd}`, payload: { expected_revision: 1 } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ lifecycle_status: "paused", next_run_at: null, revision: 2 });

    const resumed = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/resume?cwd=${cwd}`, payload: { expected_revision: 2 } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().lifecycle_status).toBe("active");

    const deleted = await h.app.inject({ method: "DELETE", url: `/api/scheduled-tasks/${taskId}?cwd=${cwd}&expected_revision=3` });
    expect(deleted.statusCode).toBe(200);
    const gone = await h.app.inject({ method: "GET", url: `/api/scheduled-tasks/${taskId}?cwd=${cwd}` });
    expect(gone.statusCode).toBe(404);
  });

  it("cancels pending attempts outright (200) and records running cancels as 202", async () => {
    const h = await harness();
    const first = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody() });
    const firstRun = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${first.json().task_id}/run?cwd=${encodeURIComponent(h.wsA)}` });
    const cancelled = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${first.json().task_id}/runs/${firstRun.json().run.run_id}/cancel?cwd=${encodeURIComponent(h.wsA)}` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe("cancelled");

    // Simulate a dispatcher lease so cancel can only be requested, not applied.
    const second = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody({ name: "Second" }) });
    const secondRun = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${second.json().task_id}/run?cwd=${encodeURIComponent(h.wsA)}` });
    const attempt = (await h.repository.listAttempts(secondRun.json().run.run_id)).items[0]!;
    const lease = await h.repository.claimAttempt(attempt.attempt_id, "owner-test", Date.now(), 30_000);
    expect(lease).not.toBeNull();
    const requested = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${second.json().task_id}/runs/${secondRun.json().run.run_id}/cancel?cwd=${encodeURIComponent(h.wsA)}` });
    expect(requested.statusCode).toBe(202);
    expect(requested.json().run.status).toBe("running");
    const after = await h.repository.getAttempt(attempt.attempt_id);
    expect(after?.cancel_requested_at).not.toBeNull();
  });

  it("retries failed runs with attempts left and refuses terminal ones", async () => {
    const h = await harness();
    const failed = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody({ name: "Failing" }) });
    const failedRun = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${failed.json().task_id}/run?cwd=${encodeURIComponent(h.wsA)}` });
    const failedAttempt = (await h.repository.listAttempts(failedRun.json().run.run_id)).items[0]!;
    const lease = await h.repository.claimAttempt(failedAttempt.attempt_id, "owner-test", Date.now(), 30_000);
    expect(lease).not.toBeNull();
    await h.repository.finishAttempt(failedAttempt.attempt_id, lease!.owner_token, lease!.owner_generation, { status: "failed", retryable: true, error_code: "PROVIDER_UNAVAILABLE" }, Date.now());
    const retried = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${failed.json().task_id}/runs/${failedRun.json().run.run_id}/retry?cwd=${encodeURIComponent(h.wsA)}` });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().attempt).toMatchObject({ attempt_no: 2, status: "pending", execution_id: expect.stringMatching(/^exec_/) });

    const cancelled = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(h.wsA)}`, payload: createBody({ name: "Cancelled" }) });
    const cancelledRun = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${cancelled.json().task_id}/run?cwd=${encodeURIComponent(h.wsA)}` });
    await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${cancelled.json().task_id}/runs/${cancelledRun.json().run.run_id}/cancel?cwd=${encodeURIComponent(h.wsA)}` });
    const refused = await h.app.inject({ method: "POST", url: `/api/scheduled-tasks/${cancelled.json().task_id}/runs/${cancelledRun.json().run.run_id}/retry?cwd=${encodeURIComponent(h.wsA)}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("RUN_RETRY_NOT_ALLOWED");
  });

  it("previews future occurrences as local/utc pairs through one guarded endpoint", async () => {
    const h = await harness();
    const cron = await h.app.inject({
      method: "POST",
      url: `/api/scheduled-tasks/preview?cwd=${encodeURIComponent(h.wsA)}`,
      payload: { schedule: { type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" }, count: 3 },
    });
    expect(cron.statusCode).toBe(200);
    expect(cron.json().items).toHaveLength(3);
    for (const item of cron.json().items) {
      expect(item.utc).toMatch(/Z$/);
      expect(item.local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    }
    expect(Date.parse(cron.json().items[0].utc)).toBeLessThan(Date.parse(cron.json().items[2].utc));

    const interval = await h.app.inject({
      method: "POST",
      url: `/api/scheduled-tasks/preview?cwd=${encodeURIComponent(h.wsA)}`,
      payload: { schedule: SCHEDULE, count: 2 },
    });
    expect(interval.statusCode).toBe(200);
    expect(interval.json().items).toHaveLength(2);

    const invalid = await h.app.inject({
      method: "POST",
      url: `/api/scheduled-tasks/preview?cwd=${encodeURIComponent(h.wsA)}`,
      payload: { schedule: { type: "once", at: "not-a-date", timezone: "UTC" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("INVALID_SCHEDULE");
  });

  it("reports diagnostics on /status without any workspace data", async () => {
    const h = await harness();
    const status = await h.app.inject({ method: "GET", url: "/api/scheduled-tasks/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: "running", feature_enabled: true, sqlite_ready: true });
    expect(JSON.stringify(status.json())).not.toContain("stask_");

    process.env.PI_SCIENCE_SCHEDULED_TASKS = "0";
    const disabled = await h.app.inject({ method: "GET", url: "/api/scheduled-tasks/status" });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ status: "disabled", feature_enabled: false });
  });

  it("answers every guarded route — preview included — with uniform 503s", async () => {
    // Flag off wins over everything else.
    const flagOff = await harness({ flag: false });
    for (const attempt of [
      h => h.app.inject({ method: "GET", url: "/api/scheduled-tasks" }),
      h => h.app.inject({ method: "GET", url: "/api/scheduled-tasks/stask_x?cwd=." }),
      h => h.app.inject({ method: "POST", url: "/api/scheduled-tasks?cwd=.", payload: {} }),
      h => h.app.inject({ method: "POST", url: "/api/scheduled-tasks/preview?cwd=.", payload: {} }),
      h => h.app.inject({ method: "POST", url: "/api/scheduled-tasks/stask_x/run?cwd=.", payload: {} }),
      h => h.app.inject({ method: "GET", url: "/api/scheduled-tasks/stask_x/runs/run_x/attempts?cwd=." }),
    ] as Array<(harness: Harness) => Promise<unknown>>) {
      const response = await attempt(flagOff) as { statusCode: number; json(): { code: string } };
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("SCHEDULED_TASKS_DISABLED");
    }

    // SQLite explicitly disabled → distinct code, preview included (docs §12.8).
    const sqliteOff = await harness({ sqlite: false });
    const listOff = await sqliteOff.app.inject({ method: "GET", url: `/api/scheduled-tasks?cwd=${encodeURIComponent(sqliteOff.wsA)}` });
    expect(listOff.statusCode).toBe(503);
    expect(listOff.json().code).toBe("SCHEDULED_TASKS_SQLITE_DISABLED");
    const previewOff = await sqliteOff.app.inject({ method: "POST", url: "/api/scheduled-tasks/preview?cwd=.", payload: { schedule: SCHEDULE } });
    expect(previewOff.statusCode).toBe(503);
    expect(previewOff.json().code).toBe("SCHEDULED_TASKS_SQLITE_DISABLED");

    // Store present but not ready → unavailable.
    const unready = await harness({ startStore: false, plainWorkspaces: true });
    const unavailable = await unready.app.inject({ method: "GET", url: "/api/scheduled-tasks?cwd=." });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().code).toBe("SCHEDULED_TASKS_SQLITE_UNAVAILABLE");
  });
});
