// Scheduled Tasks HTTP routes (Phase 6, docs §12). Every workspace-scoped
// route first validates the cwd (403 WORKSPACE_FORBIDDEN, docs §10.1) and then
// maps the typed service outcome straight onto the §12.7 error body
// {code, error, request_id, details}. Flag/SQLite guards answer a uniform 503
// on every route including /preview (docs §12.8: preview never bypasses the
// guard). /status stays observable while degraded and only ever returns the
// §11.7 diagnostics block — never workspace data.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { cronPreview, firstOccurrence, validateSchedule } from "../../scheduled-tasks/schedule.js";
import { isScheduledTasksEnabled, serviceFailure } from "../../scheduled-tasks/service.js";
import type { ScheduledTaskService } from "../../scheduled-tasks/service.js";
import { runNotFound, taskNotFound } from "../../scheduled-tasks/errors.js";
import type { ScheduledTaskRun, ScheduledTaskRunAttempt, ScheduledTaskSchedule } from "../../scheduled-tasks/types.js";
import type { SqliteStateStore } from "../../storage/sqlite/state-store.js";

interface FailureShape {
  http_status: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface ScheduledTaskRouteDeps {
  service: ScheduledTaskService;
  /** Resolves + authorizes a workspace cwd (docs §10.1); defaults to validateWorkspaceCwd. */
  workspacesResolver?: (cwd: string) => Promise<string>;
  sqliteEnabled: boolean;
  stateStore: Pick<SqliteStateStore, "diagnostics">;
  /** docs §11.3 wake hook fired after successful mutations so the nearest-deadline timer rearms. */
  onMutation?: () => void;
}

function failure(httpStatus: number, code: string, message: string, details: Record<string, unknown> = {}): FailureShape {
  return { http_status: httpStatus, code, message, details };
}

/** docs §12.7 uniform error body. */
function sendFailure(request: FastifyRequest, reply: FastifyReply, cause: FailureShape): FastifyReply {
  return reply.code(cause.http_status).send({ code: cause.code, error: cause.message, request_id: request.id, details: cause.details });
}

/** docs §15.5 flag + §12.8 SQLite guard shared by every route including preview. */
function availabilityFailure(deps: ScheduledTaskRouteDeps): FailureShape | null {
  if (!isScheduledTasksEnabled()) return failure(503, "SCHEDULED_TASKS_DISABLED", "Scheduled tasks feature is disabled (PI_SCIENCE_SCHEDULED_TASKS != 1)");
  if (!deps.sqliteEnabled) return failure(503, "SCHEDULED_TASKS_SQLITE_DISABLED", "Durable SQLite state is disabled in this process");
  if (deps.stateStore.diagnostics().status !== "ready") return failure(503, "SCHEDULED_TASKS_SQLITE_UNAVAILABLE", "Durable SQLite state is not ready");
  return null;
}

function rawCwd(request: FastifyRequest): string {
  return new URL(request.url, "http://localhost").searchParams.get("cwd") ?? "";
}

async function resolveCwd(request: FastifyRequest, deps: ScheduledTaskRouteDeps): Promise<string> {
  const resolver = deps.workspacesResolver ?? validateWorkspaceCwd;
  return resolver(rawCwd(request));
}

function forbidden(request: FastifyRequest, reply: FastifyReply, cwd: string): FastifyReply {
  return sendFailure(request, reply, { ...serviceFailure(new Error(`Path is not a registered workspace: ${cwd}`)), http_status: 403, code: "WORKSPACE_FORBIDDEN" });
}

function listOptions(request: FastifyRequest): { limit?: number; cursor?: string | null } {
  const params = new URL(request.url, "http://localhost").searchParams;
  const rawLimit = params.get("limit");
  return { limit: rawLimit !== null && /^\d+$/.test(rawLimit) ? Number(rawLimit) : undefined, cursor: params.get("cursor") };
}

/** expected_revision comes from the JSON body, or from the query string on DELETE. */
function expectedRevisionOf(request: FastifyRequest): number | null {
  const body = (request.body ?? {}) as { expected_revision?: unknown };
  const raw = request.method === "DELETE"
    ? (new URL(request.url, "http://localhost").searchParams.get("expected_revision") ?? body.expected_revision)
    : body.expected_revision;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function malformedRevision(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendFailure(request, reply, failure(400, "SCHEDULED_TASK_POLICY_VIOLATION", "expected_revision must be an integer"));
}

/** docs §12.4 manual-run response slice. */
function manualRunView(run: ScheduledTaskRun, attempt: ScheduledTaskRunAttempt | null) {
  return {
    run_id: run.run_id,
    task_id: run.task_id,
    status: run.status,
    trigger_source: "manual" as const,
    latest_attempt: attempt === null || attempt === undefined ? null : {
      attempt_id: attempt.attempt_id,
      attempt_no: attempt.attempt_no,
      status: attempt.status,
      execution_id: attempt.execution_id,
    },
  };
}

// --- preview (docs §12.1/§13.2): server-authoritative occurrence preview ------

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(timestampMs: number, timezone: string): string {
  let formatter = wallClockFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    wallClockFormatters.set(timezone, formatter);
  }
  return formatter.format(timestampMs).replace(", ", " ");
}

/** Next `count` occurrences as {local, utc} pairs. Cron goes through the same
 * parser wrapper as the scheduler (cronPreview); once/interval walk
 * firstOccurrence so every schedule type previews identically to claiming. */
function previewSchedule(rawSchedule: unknown, timezoneOverride: unknown, count: number, nowMs: number): Array<{ utc: string; local: string }> {
  const candidate = typeof timezoneOverride === "string" && timezoneOverride && rawSchedule && typeof rawSchedule === "object"
    ? { ...(rawSchedule as Record<string, unknown>), timezone: timezoneOverride }
    : rawSchedule;
  const schedule: ScheduledTaskSchedule = validateSchedule(candidate);
  if (schedule.type === "cron") return cronPreview(schedule, count, nowMs).map(({ utc, local }) => ({ utc, local }));
  const items: Array<{ utc: string; local: string }> = [];
  let cursor = nowMs;
  for (let index = 0; index < count; index += 1) {
    const timestampMs = firstOccurrence(schedule, cursor);
    if (timestampMs === null) break;
    items.push({ utc: new Date(timestampMs).toISOString(), local: wallClock(timestampMs, schedule.timezone) });
    cursor = timestampMs;
  }
  return items;
}

/** §11.7 diagnostics block aggregated over the service (which folds the
 * injected scheduler/dispatcher slices) plus SQLite readiness. */
export async function scheduledTasksDiagnostics(deps: Pick<ScheduledTaskRouteDeps, "service" | "sqliteEnabled" | "stateStore">) {
  const base = await deps.service.diagnostics();
  return { ...base, sqlite_ready: deps.sqliteEnabled && deps.stateStore.diagnostics().status === "ready" };
}

export function registerScheduledTaskRoutes(app: FastifyInstance, deps: ScheduledTaskRouteDeps): void {
  const { service } = deps;
  type TaskParams = { task_id: string };
  type RunParams = { task_id: string; run_id: string };
  const taskParams = (request: FastifyRequest): string => (request.params as TaskParams).task_id;
  const runParams = (request: FastifyRequest): RunParams => request.params as RunParams;

  // --- collection ------------------------------------------------------------

  app.get("/api/scheduled-tasks", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const outcome = await service.listTasks(cwd, listOptions(request));
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    return { items: outcome.value.items, next_cursor: outcome.value.next_cursor };
  });

  app.post("/api/scheduled-tasks", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const outcome = await service.createTask(cwd, {
      name: String(body.name ?? ""),
      schedule: body.schedule,
      executor: body.executor as never,
      output: (body.output ?? { relative_root: "" }) as { relative_root: string },
      retry: body.retry as never,
      budget: body.budget as never,
      misfire_policy: body.misfire_policy as never,
      concurrency_policy: body.concurrency_policy as never,
    });
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    deps.onMutation?.();
    return reply.code(201).send(outcome.value);
  });

  app.post("/api/scheduled-tasks/preview", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const body = (request.body ?? {}) as { schedule?: unknown; timezone?: unknown; count?: unknown };
    const rawCount = typeof body.count === "number" && Number.isFinite(body.count) ? Math.floor(body.count) : 3;
    try {
      const items = previewSchedule(body.schedule, body.timezone, Math.min(10, Math.max(1, rawCount)), Date.now());
      return { items };
    } catch (error) {
      return sendFailure(request, reply, serviceFailure(error));
    }
  });

  app.get("/api/scheduled-tasks/status", async () => scheduledTasksDiagnostics(deps));

  // --- single task -----------------------------------------------------------

  app.get("/api/scheduled-tasks/:task_id", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const outcome = await service.getTask(taskParams(request), cwd);
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    // Deleted/cross-workspace reads collapse to 404 (docs §12.8).
    if (outcome.value === null) return sendFailure(request, reply, serviceFailure(taskNotFound(taskParams(request))));
    return outcome.value;
  });

  app.patch("/api/scheduled-tasks/:task_id", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const expectedRevision = expectedRevisionOf(request);
    if (expectedRevision === null) return malformedRevision(request, reply);
    const patch = ((request.body ?? {}) as { patch?: unknown }).patch ?? {};
    const outcome = await service.patchTask(taskParams(request), cwd, expectedRevision, patch as never);
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    deps.onMutation?.();
    return outcome.value;
  });

  for (const action of ["pause", "resume"] as const) {
    app.post(`/api/scheduled-tasks/:task_id/${action}`, async (request, reply) => {
      const denied = availabilityFailure(deps);
      if (denied) return sendFailure(request, reply, denied);
      let cwd: string;
      try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
      const expectedRevision = expectedRevisionOf(request);
      if (expectedRevision === null) return malformedRevision(request, reply);
      const outcome = await service.setTaskStatus(taskParams(request), cwd, expectedRevision, action);
      if (!outcome.ok) return sendFailure(request, reply, outcome.error);
      deps.onMutation?.();
      return outcome.value;
    });
  }

  app.delete("/api/scheduled-tasks/:task_id", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const expectedRevision = expectedRevisionOf(request);
    if (expectedRevision === null) return malformedRevision(request, reply);
    const outcome = await service.setTaskStatus(taskParams(request), cwd, expectedRevision, "delete");
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    deps.onMutation?.();
    return outcome.value;
  });

  app.post("/api/scheduled-tasks/:task_id/approve", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const expectedRevision = expectedRevisionOf(request);
    if (expectedRevision === null) return malformedRevision(request, reply);
    const body = (request.body ?? {}) as { approval_scope_hash?: unknown; categories?: unknown };
    if (typeof body.approval_scope_hash !== "string" || !body.approval_scope_hash) {
      return sendFailure(request, reply, failure(400, "SCHEDULED_TASK_POLICY_VIOLATION", "approval_scope_hash must be a non-empty string"));
    }
    if (!Array.isArray(body.categories)) return sendFailure(request, reply, failure(400, "SCHEDULED_TASK_POLICY_VIOLATION", "categories must be an array"));
    const outcome = await service.approveTask(taskParams(request), cwd, expectedRevision, body.approval_scope_hash, body.categories.map(String));
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    deps.onMutation?.();
    return outcome.value;
  });

  // --- manual run (docs §12.4: 202, never waits for execution) ----------------

  app.post("/api/scheduled-tasks/:task_id/run", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const outcome = await service.runNow(taskParams(request), cwd);
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    deps.onMutation?.();
    // A skipped manual run (overlap forbid) has no attempt yet → latest_attempt: null.
    let attempt: ScheduledTaskRunAttempt | null = null;
    if (outcome.value.status === "created") {
      const attempts = await service.listAttempts(taskParams(request), outcome.value.run.run_id, cwd, { limit: 1 });
      attempt = attempts.ok ? attempts.value.items[0] ?? null : null;
    }
    const view = manualRunView(outcome.value.run, attempt);
    const location = `/api/scheduled-tasks/${outcome.value.run.task_id}/runs/${outcome.value.run.run_id}?cwd=${encodeURIComponent(cwd)}`;
    return reply.code(202).header("location", location).send({ run: view });
  });

  // --- run history -------------------------------------------------------------

  app.get("/api/scheduled-tasks/:task_id/runs", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const outcome = await service.listRuns(taskParams(request), cwd, listOptions(request));
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    return { items: outcome.value.items, next_cursor: outcome.value.next_cursor };
  });

  app.get("/api/scheduled-tasks/:task_id/runs/:run_id", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const ids = runParams(request);
    const runOutcome = await service.getRun(ids.run_id, cwd);
    if (!runOutcome.ok) return sendFailure(request, reply, runOutcome.error);
    // Cross-workspace and cross-task ids both read as missing (docs §12.8).
    if (runOutcome.value === null || runOutcome.value.task_id !== ids.task_id) {
      return sendFailure(request, reply, serviceFailure(runNotFound(ids.run_id)));
    }
    return runOutcome.value;
  });

  app.get("/api/scheduled-tasks/:task_id/runs/:run_id/attempts", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const ids = runParams(request);
    const runOutcome = await service.getRun(ids.run_id, cwd);
    if (!runOutcome.ok) return sendFailure(request, reply, runOutcome.error);
    if (runOutcome.value === null || runOutcome.value.task_id !== ids.task_id) {
      return sendFailure(request, reply, serviceFailure(runNotFound(ids.run_id)));
    }
    const outcome = await service.listAttempts(ids.task_id, ids.run_id, cwd, listOptions(request));
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    return { items: outcome.value.items, next_cursor: outcome.value.next_cursor };
  });

  app.post("/api/scheduled-tasks/:task_id/runs/:run_id/cancel", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const ids = runParams(request);
    const runOutcome = await service.getRun(ids.run_id, cwd);
    if (!runOutcome.ok) return sendFailure(request, reply, runOutcome.error);
    if (runOutcome.value === null || runOutcome.value.task_id !== ids.task_id) {
      return sendFailure(request, reply, serviceFailure(runNotFound(ids.run_id)));
    }
    const outcome = await service.cancelRun(ids.run_id, cwd);
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    deps.onMutation?.();
    // Pending attempt cancelled outright → final 200; running attempt only got
    // a durable cancel_requested_at → accepted 202 (docs §12.4).
    return reply.code(outcome.value.status === "cancelled" ? 200 : 202).send({ run: outcome.value.run });
  });

  app.post("/api/scheduled-tasks/:task_id/runs/:run_id/retry", async (request, reply) => {
    const denied = availabilityFailure(deps);
    if (denied) return sendFailure(request, reply, denied);
    let cwd: string;
    try { cwd = await resolveCwd(request, deps); } catch { return forbidden(request, reply, rawCwd(request)); }
    const ids = runParams(request);
    const outcome = await service.retryRun(ids.task_id, ids.run_id, cwd);
    if (!outcome.ok) return sendFailure(request, reply, outcome.error);
    deps.onMutation?.();
    return reply.code(202).send({ attempt: outcome.value });
  });
}
