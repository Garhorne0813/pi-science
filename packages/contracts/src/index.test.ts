import { describe, expect, it } from "vitest";
import { artifactLineageResponseSchema, artifactManifestSchema, artifactManifestV2Schema, artifactVersionRefSchema, conversationAttentionResponseSchema, conversationBookmarkCreateSchema, conversationBookmarkSchema, conversationBookmarkUpdateSchema, conversationReadStateResponseSchema, createResearchLoopSchema, createSessionRequestSchema, gatewayHealthSchema, jobRecordSchema, piRpcCommandSchema, researchLoopSchema, sessionEventSchema, sessionMessageIndexEntrySchema, skillContentSchema } from "./index.js";

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

  it("validates artifact v2 manifests with exact version refs", () => {
    const ref = artifactVersionRefSchema.parse({ artifact_id: "a1", version: 2 });
    expect(ref).toEqual({ artifact_id: "a1", version: 2 });
    expect(() => artifactVersionRefSchema.parse({ artifact_id: "a1", version: 0 })).toThrow();
    expect(() => artifactVersionRefSchema.parse({ artifact_id: "a1", version: 2.5 })).toThrow();

    const manifest = artifactManifestV2Schema.parse({
      schema_version: 2, artifact_id: "a2", version: 3, path: "out/plot.png", kind: "image",
      mime: "image/png", size: 10, sha256: "1234567890abcdef", published_at: "now",
      inputs: [{ artifact_id: "a1", version: 2 }, "legacy/path.txt"],
      supersedes: { artifact_id: "a2", version: 2 },
      classification: "deliverable",
    });
    expect(manifest.inputs).toHaveLength(2);
    expect(manifest.supersedes).toEqual({ artifact_id: "a2", version: 2 });
    expect(manifest.classification).toBe("deliverable");

    // Invalid classification and over-limit inputs are rejected.
    expect(() => artifactManifestV2Schema.parse({
      schema_version: 2, artifact_id: "a2", version: 3, path: "out.txt", kind: "text",
      mime: "text/plain", size: 1, sha256: "1234567890abcdef", published_at: "now",
      classification: "published",
    })).toThrow();
    expect(() => artifactManifestV2Schema.parse({
      schema_version: 2, artifact_id: "a2", version: 3, path: "out.txt", kind: "text",
      mime: "text/plain", size: 1, sha256: "1234567890abcdef", published_at: "now",
      inputs: Array.from({ length: 101 }, (_, i) => ({ artifact_id: `a${i}`, version: 1 })),
    })).toThrow();
  });

  it("validates artifact lineage responses", () => {
    const manifest = (overrides: Record<string, unknown> = {}) => ({
      schema_version: 2, artifact_id: "a2", version: 3, path: "out/plot.png", kind: "image",
      mime: "image/png", size: 10, sha256: "1234567890abcdef", published_at: "now",
      inputs: [], supersedes: null, classification: "deliverable", ...overrides,
    });
    expect(artifactLineageResponseSchema.parse({
      artifact: manifest(),
      upstream: [{ kind: "consumes", artifact: manifest({ artifact_id: "a1", version: 2, path: "in.csv" }) }],
      downstream: [{ kind: "consumed_by", artifact: manifest({ artifact_id: "a3", version: 1, path: "final.csv" }) }],
      unresolved_inputs: ["legacy/path.txt"],
    })).toMatchObject({ unresolved_inputs: ["legacy/path.txt"] });
    expect(() => artifactLineageResponseSchema.parse({
      artifact: manifest(),
      upstream: [{ kind: "uses", artifact: manifest() }],
      unresolved_inputs: [],
    })).toThrow();
    expect(artifactLineageResponseSchema.parse({
      artifact: manifest(),
      upstream: [{ kind: "derived_from", artifact: manifest({ artifact_id: "a1" }) }],
      downstream: [{ kind: "derived", artifact: manifest({ artifact_id: "a3" }) }],
      unresolved_inputs: [],
    })).toMatchObject({ upstream: [{ kind: "derived_from" }], downstream: [{ kind: "derived" }] });
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

  it("validates conversation bookmarks and rejects invalid roles and lengths", () => {
    expect(conversationBookmarkSchema.parse({
      bookmark_id: "b1", session_id: "s1", message_id: "m1", role: "user",
      quote: "a finding", label: "Key result", origin: "user", status: "accepted",
      created_at: "now", updated_at: "now",
    })).toMatchObject({ role: "user", status: "accepted" });
    expect(() => conversationBookmarkSchema.parse({
      bookmark_id: "b1", session_id: "s1", message_id: "m1", role: "tool",
      quote: "a finding", label: null, origin: "user", status: "accepted",
      created_at: "now", updated_at: "now",
    })).toThrow();
    expect(() => conversationBookmarkSchema.parse({
      bookmark_id: "b1", session_id: "s1", message_id: "m1", role: "assistant",
      quote: "a", label: "x".repeat(161), origin: "user", status: "accepted",
      created_at: "now", updated_at: "now",
    })).toThrow();
    expect(() => conversationBookmarkSchema.parse({
      bookmark_id: "b1", session_id: "s1", message_id: "m1", role: "assistant",
      quote: "q".repeat(501), label: null, origin: "user", status: "accepted",
      created_at: "now", updated_at: "now",
    })).toThrow();
    expect(() => conversationBookmarkUpdateSchema.parse({ status: "pending" })).toThrow();
    expect(() => conversationBookmarkCreateSchema.parse({ session_id: "s1" })).toThrow();
  });

  it("validates read-state responses and all-role message index entries", () => {
    expect(conversationReadStateResponseSchema.parse({
      session_id: "s1", anchor_message_id: "m2", at_bottom: false,
      seen_snapshot_version: "v1", updated_at: "now", anchor_available: true, before: "cur",
    })).toMatchObject({ anchor_available: true, before: "cur" });
    // The synthetic empty (never-read) response is nullable for updated_at.
    expect(conversationReadStateResponseSchema.parse({
      session_id: "s1", anchor_message_id: null, at_bottom: false,
      seen_snapshot_version: null, updated_at: null, anchor_available: false, before: null,
    })).toMatchObject({ anchor_available: false, before: null, updated_at: null });
    expect(() => conversationReadStateResponseSchema.parse({
      session_id: "s1", anchor_message_id: "m2", at_bottom: false,
      seen_snapshot_version: "v1", updated_at: "now", anchor_available: true,
    })).toThrow();
    expect(sessionMessageIndexEntrySchema.parse({
      id: "m1", role: "assistant", text: "hi", timestamp: null, before: "cur",
    })).toMatchObject({ role: "assistant" });
    expect(() => sessionMessageIndexEntrySchema.parse({
      id: "m1", role: "tool", text: "hi", timestamp: null, before: "cur",
    })).toThrow();
  });

  it("validates attention responses and rejects negative limits", () => {
    const parsed = conversationAttentionResponseSchema.parse({
      items: [
        { session_id: "s1", status: "needs_you", updated_at: null },
        { session_id: "s2", status: "running", updated_at: null },
        { session_id: "s3", status: "unread", updated_at: null },
        { session_id: "s4", status: "idle", updated_at: null },
      ],
      counts: { needs_you: 1, running: 1, unread: 1 },
      truncated: false,
    });
    expect(parsed.counts).toMatchObject({ needs_you: 1, running: 1, unread: 1 });
    expect(() => conversationAttentionResponseSchema.parse({
      items: [{ session_id: "s1", status: "drafting", updated_at: null }],
      counts: { needs_you: 0, running: 0, unread: 0 },
      truncated: false,
    })).toThrow();
  });
});
