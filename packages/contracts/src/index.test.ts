import { describe, expect, it } from "vitest";
import { artifactManifestSchema, createResearchLoopSchema, createSessionRequestSchema, executionEventSchema, executionRecordSchema, gatewayHealthSchema, jobRecordSchema, piRpcCommandSchema, researchLoopSchema, sessionEventSchema, sessionStatsSchema, skillContentSchema } from "./index.js";

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
});
