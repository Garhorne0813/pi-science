import { describe, expect, it, vi } from "vitest";
import type { AutoResearchSnapshot } from "@pi-science/contracts";
import type { PiManagedResearchRuntime } from "../runtimes/pi-managed-runtime.js";
import { PiResearchSupervisor } from "./pi-supervisor-runner.js";

const snapshot = {
  schema_version: 1,
  research_id: "research-0123456789abcdef",
  project_id: "workspace",
  origin_session_id: null,
  origin_message_id: null,
  revision: 2,
  title: "t",
  objective: "Improve score",
  constraints: [],
  budget: { max_experiments: 20, max_wall_seconds: 7200, max_model_tokens: null, max_cost_usd: null, max_parallel: 2 },
  usage: { experiments_started: 0, experiments_completed: 0, model_tokens: 0, cost_usd: 0, active_wall_ms: 0 },
  target_metrics: {},
  status: "running",
  nodes: [
    { node_id: "node-1111111111111111", kind: "question", question: "?", status: "succeeded", priority: 1, created_at: "t", updated_at: "t" },
    { node_id: "node-2222222222222222", kind: "hypothesis", statement: "H1", assumptions: [], status: "succeeded", priority: 1, created_at: "t", updated_at: "t" },
    { node_id: "node-3333333333333333", kind: "experiment", status: "succeeded", priority: 1, created_at: "t", updated_at: "t", hypothesis_refs: [] },
  ],
  edges: [],
  claims: [],
  evidence: [],
  claim_evidence: [],
  current_activity: null,
  best_result: null,
  started_at: null,
  completed_at: null,
  stop_reason: null,
} as unknown as AutoResearchSnapshot;

function validCommit(rationale: string) {
  return {
    research_id: snapshot.research_id,
    base_revision: snapshot.revision,
    rationale,
    actions: [
      { action_id: "s1", type: "synthesis.request", target_node_ids: ["node-3333333333333333"], priority: 1 },
    ],
  };
}

function runtimeWith(sequence: Array<() => Promise<unknown>>): PiManagedResearchRuntime & { run: ReturnType<typeof vi.fn> } {
  const calls: string[] = [];
  const run = vi.fn(async (input: { prompt: string }) => {
    calls.push(input.prompt);
    const next = sequence.shift();
    if (!next) throw new Error("unexpected extra run");
    return next();
  });
  return {
    run,
    sessionIds: () => calls.length,
    cancel: vi.fn(),
    cancelResearch: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as PiManagedResearchRuntime & { run: ReturnType<typeof vi.fn> };
}

describe("PiResearchSupervisor", () => {
  it("retries a schema-invalid commit with the validation error fed back, then succeeds", async () => {
    const runtime = runtimeWith([
      async () => { throw new Error("Invalid string: must match pattern /^node-[a-z0-9]{16}$/"); },
      async () => ({ details: validCommit("fixed"), model_tokens: 3, cost_usd: 0.01 }),
    ]);
    const supervisor = new PiResearchSupervisor(runtime);
    const decision = await supervisor.decide("cwd", snapshot);
    expect(decision.commit).toMatchObject({ rationale: "fixed" });
    expect(decision.model_tokens).toBe(3);
    expect(runtime.run).toHaveBeenCalledTimes(2);
    // Second attempt carries the validation error so the model can repair it.
    const secondPrompt = (runtime.run.mock.calls[1]![0] as { prompt: string }).prompt;
    expect(secondPrompt).toContain("rejected by validation");
    expect(secondPrompt).toContain("node-[a-z0-9]{16}");
    expect(secondPrompt).toContain("copied verbatim");
  });

  it("fails only after exhausting all commit attempts", async () => {
    const runtime = runtimeWith([
      async () => { throw new Error("bad plan 1"); },
      async () => { throw new Error("bad plan 2"); },
      async () => { throw new Error("bad plan 3"); },
    ]);
    const supervisor = new PiResearchSupervisor(runtime, 3);
    await expect(supervisor.decide("cwd", snapshot)).rejects.toThrow("bad plan 3");
    expect(runtime.run).toHaveBeenCalledTimes(3);
  });
});