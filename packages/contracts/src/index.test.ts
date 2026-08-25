import { describe, expect, it } from "vitest";
import {
  artifactManifestSchema,
  concurrencyPolicySchema,
  createResearchLoopSchema,
  createSessionRequestSchema,
  executionEventSchema,
  executionRecordSchema,
  gatewayHealthSchema,
  jobRecordSchema,
  literatureDigestConfigSchema,
  literatureProviderSchema,
  misfirePolicySchema,
  piRpcCommandSchema,
  researchLoopSchema,
  retryPolicySchema,
  scheduledTaskApprovalSchema,
  scheduledTaskBudgetSchema,
  scheduledTaskExecutorSchema,
  scheduledTaskScheduleSchema,
  sessionEventSchema,
  sessionStatsSchema,
  skillContentSchema,
} from "./index.js";

describe("gateway contracts", () => {
  it("accepts a healthy Node gateway response", () => {
    expect(
      gatewayHealthSchema.parse({
        status: "ok",
        active_pi_processes: 1,
        active_kernels: 2,
        service: "pi-science-server",
        control_plane: "node",
        scientific_runtime: "idle",
      }),
    ).toMatchObject({ service: "pi-science-server", control_plane: "node" });
  });

  it("validates durable execution events and reduced records", () => {
    expect(executionEventSchema.parse({
      schema_version: 1,
      event_id: "event-1",
      execution_id: "exec-1",
      sequence: 1,
      event_type: "execution.started",
      kind: "job",
      surface: "local",
      workspace_id: "/tmp/project",
      created_at: "now",
      producer: "test",
    })).toMatchObject({ payload: {}, sequence: 1 });
    expect(executionRecordSchema.parse({
      schema_version: 1,
      execution_id: "exec-1",
      kind: "job",
      surface: "local",
      status: "running",
      workspace_id: "/tmp/project",
      created_at: "now",
      producer: "test",
    })).toMatchObject({ correlation: {}, files: { read: [], written: [] }, artifacts: [] });
  });

  it("validates session requests and preserves event extensions", () => {
    expect(createSessionRequestSchema.parse({ cwd: "/tmp/project" })).toMatchObject({ cwd: "/tmp/project" });
    expect(sessionEventSchema.parse({ type: "session.idle", sessionId: "s1", cursor: 4 })).toMatchObject({ cursor: 4 });
    expect(() => createSessionRequestSchema.parse({ cwd: "" })).toThrow();
    expect(piRpcCommandSchema.parse({ id: "r1", type: "get_state", extra: true })).toMatchObject({ id: "r1", extra: true });
    expect(jobRecordSchema.parse({ id: "j1", status: "queued", created_at: "now" })).toMatchObject({ status: "queued" });
    expect(artifactManifestSchema.parse({ artifact_id: "a1", version: 1, path: "out.txt", kind: "text", mime: "text/plain", size: 1, sha256: "1234567890abcdef", published_at: "now" })).toMatchObject({ artifact_id: "a1" });
  });

  it("validates session stats and the session.stats SSE event", () => {
    const stats = {
      userMessages: 3,
      assistantMessages: 4,
      toolCalls: 7,
      toolResults: 7,
      totalMessages: 16,
      tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
      cost: 0.45,
      llmMs: 6000,
      toolMs: 2500,
      ttftMs: 300,
      ttftSteps: 4,
      decodeMs: 5200,
    };
    expect(sessionStatsSchema.parse(stats)).toMatchObject({ toolCalls: 7, decodeMs: 5200 });
    // Timing fields are optional for cold-restored sessions.
    expect(sessionStatsSchema.parse({ ...stats, llmMs: undefined }).llmMs).toBeUndefined();
    expect(() => sessionStatsSchema.parse({ ...stats, tokens: { input: 1 } })).toThrow();
    expect(() => sessionStatsSchema.parse({ ...stats, userMessages: -1 })).toThrow();
    expect(sessionEventSchema.parse({ type: "session.stats", sessionId: "s1", stats })).toMatchObject({ type: "session.stats" });
  });

  it("preserves research task types while defaulting legacy loops", () => {
    expect(createResearchLoopSchema.parse({ title: "Tune latency", objective: "Minimize latency", task_type: "optimize" }).task_type).toBe("optimize");
    expect(createResearchLoopSchema.parse({ title: "Legacy", objective: "Explore" }).task_type).toBe("research_loop");
    expect(researchLoopSchema.parse({
      loop_id: "loop-1", title: "Legacy", objective: "Explore", status: "draft",
      budget: { max_candidates: 2, max_wall_seconds: 60, max_parallel: 1 },
      stop_conditions: { target_metrics: {}, patience: 3, min_improvement: 0 },
      created_at: "now", updated_at: "now",
    }).task_type).toBe("research_loop");
  });

  it("validates skill content and rejects absolute locations", () => {
    expect(skillContentSchema.parse({
      skill_id: "s1", name: "alpha", digest: "0123456789abcdef",
      source: "builtin", location: "alpha/SKILL.md", content: "---\nname: alpha\n---\n",
    })).toMatchObject({ source: "builtin" });
    expect(() => skillContentSchema.parse({
      skill_id: "s1", name: "alpha", digest: "0123456789abcdef",
      source: "builtin", location: "/etc/SKILL.md", content: "x",
    })).toThrow();
    expect(() => skillContentSchema.parse({
      skill_id: "s1", name: "alpha", digest: "0123456789abcdef",
      source: "root", location: "alpha/SKILL.md", content: "x",
    })).toThrow();
    expect(() => skillContentSchema.parse({
      skill_id: "s1", name: "alpha", digest: "0123456789abcdef",
      source: "builtin", location: "alpha/SKILL.md",
    })).toThrow();
  });

  it("validates scheduled-task execution kind and correlation ids", () => {
    const base = {
      schema_version: 1,
      event_id: "event-2",
      execution_id: "exec-2",
      sequence: 1,
      event_type: "execution.started",
      surface: "pi",
      workspace_id: "/tmp/project",
      created_at: "now",
      producer: "scheduled-task-service",
    };
    expect(executionEventSchema.parse({ ...base, kind: "scheduled_task", payload: { correlation: { scheduled_task_id: "task-1", scheduled_task_run_id: "run-7", scheduled_task_attempt_id: "attempt-2" } } })).toMatchObject({ kind: "scheduled_task" });
    expect(executionRecordSchema.parse({
      schema_version: 1,
      execution_id: "exec-2",
      kind: "scheduled_task",
      surface: "pi",
      status: "running",
      workspace_id: "/tmp/project",
      created_at: "now",
      producer: "scheduled-task-service",
      correlation: { scheduled_task_id: "task-1", run_id: "run-7" },
    }).correlation).toMatchObject({ scheduled_task_id: "task-1", run_id: "run-7" });
    // Unknown kinds and non-string correlation ids are rejected at the wire layer.
    expect(() => executionEventSchema.parse({ ...base, kind: "shell" })).toThrow();
    expect(() => executionRecordSchema.parse({
      schema_version: 1,
      execution_id: "exec-2",
      kind: "scheduled_task",
      surface: "pi",
      status: "running",
      workspace_id: "/tmp/project",
      created_at: "now",
      producer: "scheduled-task-service",
      correlation: { scheduled_task_attempt_id: 7 },
    })).toThrow();
  });

  it("validates scheduled task schedules and rejects malformed ones", () => {
    expect(scheduledTaskScheduleSchema.parse({ type: "once", at: "2026-09-01T09:00:00+08:00", timezone: "Asia/Shanghai" })).toMatchObject({ type: "once" });
    expect(scheduledTaskScheduleSchema.parse({ type: "interval", every_seconds: 3600, anchor_at: "2026-08-25T00:00:00.000Z", timezone: "UTC" })).toMatchObject({ type: "interval" });
    expect(scheduledTaskScheduleSchema.parse({ type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" })).toMatchObject({ type: "cron" });
    // once.at must carry Z or an explicit offset.
    expect(() => scheduledTaskScheduleSchema.parse({ type: "once", at: "2026-09-01T09:00:00", timezone: "Asia/Shanghai" })).toThrow();
    // interval floor is 300s and anchor_at must be UTC-normalized.
    expect(() => scheduledTaskScheduleSchema.parse({ type: "interval", every_seconds: 299, anchor_at: "2026-08-25T00:00:00.000Z", timezone: "UTC" })).toThrow();
    expect(() => scheduledTaskScheduleSchema.parse({ type: "interval", every_seconds: 3600, anchor_at: "2026-08-25T00:00:00+00:00", timezone: "UTC" })).toThrow();
    // cron is strictly 5 fields; seconds forms are rejected at the wire layer too.
    expect(() => scheduledTaskScheduleSchema.parse({ type: "cron", expression: "0 9 * * * *", timezone: "UTC" })).toThrow();
  });

  it("allows only the literature_digest executor and known providers", () => {
    const executor = {
      kind: "literature_digest" as const,
      config: { query: "CRISPR off-target", providers: ["pubmed"] },
    };
    expect(scheduledTaskExecutorSchema.parse(executor)).toMatchObject({ config: { max_results: 30, language: "zh-CN" } });
    // Shell / job_command / command fields have no place in v1 contracts (docs §3.3).
    for (const kind of ["shell", "job_command", "job", "command"]) {
      expect(() => scheduledTaskExecutorSchema.parse({ ...executor, kind })).toThrow();
    }
    // Unknown execution fields are stripped, never carried into the typed result.
    expect(scheduledTaskExecutorSchema.parse({ ...executor, command: ["rm", "-rf"] })).not.toHaveProperty("command");
    expect(literatureProviderSchema.parse("pubmed")).toBe("pubmed");
    // crossref is deliberately absent from v1 providers.
    expect(() => literatureProviderSchema.parse("crossref")).toThrow();
    expect(() => literatureDigestConfigSchema.parse({ query: "", providers: ["pubmed"] })).toThrow();
    expect(() => literatureDigestConfigSchema.parse({ query: "q", providers: [] })).toThrow();
    expect(() => literatureDigestConfigSchema.parse({ query: "q", providers: ["pubmed"], max_results: 101 })).toThrow();
  });

  it("applies retry/budget/policy/approval defaults for scheduled tasks", () => {
    expect(retryPolicySchema.parse({})).toEqual({ max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 });
    expect(() => retryPolicySchema.parse({ max_attempts: 6 })).toThrow();
    expect(scheduledTaskBudgetSchema.parse({})).toEqual({ max_wall_time_seconds: 900 });
    expect(() => scheduledTaskBudgetSchema.parse({ max_wall_time_seconds: 59 })).toThrow();
    expect(misfirePolicySchema.parse("skip")).toBe("skip");
    expect(() => misfirePolicySchema.parse("run_all")).toThrow();
    expect(concurrencyPolicySchema.parse("forbid")).toBe("forbid");
    expect(() => concurrencyPolicySchema.parse("allow")).toThrow();
    const approval = scheduledTaskApprovalSchema.parse({});
    expect(approval).toEqual({ status: "none", scope_hash: "", approved_revision: null, categories: [], terms: [], approved_at: null });
  });
});
