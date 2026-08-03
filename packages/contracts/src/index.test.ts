import { describe, expect, it } from "vitest";
import { artifactManifestSchema, createResearchLoopSchema, createSessionRequestSchema, gatewayHealthSchema, jobRecordSchema, piRpcCommandSchema, researchLoopSchema, sessionEventSchema, skillContentSchema } from "./index.js";

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

  it("validates session requests and preserves event extensions", () => {
    expect(createSessionRequestSchema.parse({ cwd: "/tmp/project" })).toMatchObject({ cwd: "/tmp/project" });
    expect(sessionEventSchema.parse({ type: "session.idle", sessionId: "s1", cursor: 4 })).toMatchObject({ cursor: 4 });
    expect(() => createSessionRequestSchema.parse({ cwd: "" })).toThrow();
    expect(piRpcCommandSchema.parse({ id: "r1", type: "get_state", extra: true })).toMatchObject({ id: "r1", extra: true });
    expect(jobRecordSchema.parse({ id: "j1", status: "queued", created_at: "now" })).toMatchObject({ status: "queued" });
    expect(artifactManifestSchema.parse({ artifact_id: "a1", version: 1, path: "out.txt", kind: "text", mime: "text/plain", size: 1, sha256: "1234567890abcdef", published_at: "now" })).toMatchObject({ artifact_id: "a1" });
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
