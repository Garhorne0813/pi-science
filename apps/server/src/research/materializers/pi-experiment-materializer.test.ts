import { describe, expect, it, vi } from "vitest";
import type { AutoResearchSnapshot } from "@pi-science/contracts";
import type { PiManagedResearchRuntime } from "../runtimes/pi-managed-runtime.js";
import { MaterializationError, PiExperimentMaterializer } from "./pi-experiment-materializer.js";

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
    { node_id: "node-2222222222222222", kind: "experiment", spec: {}, status: "ready", priority: 1, created_at: "t", updated_at: "t", hypothesis_refs: [] },
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

const validDetails = {
  research_id: "research-0123456789abcdef",
  node_id: "node-2222222222222222",
  approach_summary: "analyze",
  rationale: "r",
  files: { "solve.py": "print(1)" },
  entrypoint: "solve.py",
  expected_artifacts: [{ path: "result.json", kind: "data" }],
};

function runtimeWith(sequence: Array<() => Promise<unknown>>) {
  const calls: string[] = [];
  const run = vi.fn(async (input: { prompt: string }) => {
    calls.push(input.prompt);
    const next = sequence.shift();
    if (!next) throw new Error("unexpected extra run");
    return next();
  });
  return { run, calls } as unknown as PiManagedResearchRuntime & { run: typeof run; calls: string[] };
}

describe("PiExperimentMaterializer", () => {
  it("retries a failed materialization, carries failed usage into the total, and feeds the error back", async () => {
    const runtime = runtimeWith([
      async () => { throw Object.assign(new Error("materializer-... runtime timed out"), { model_tokens: 42_000, cost_usd: 0.01 }); },
      async () => ({ details: validDetails, model_tokens: 8_000, cost_usd: 0.002 }),
    ]);
    const materializer = new PiExperimentMaterializer(runtime);
    const result = await materializer.materialize("cwd", snapshot, "node-2222222222222222");
    expect(result.proposal.entrypoint).toBe("solve.py");
    // Failed attempt is accounted: 42_000 + 8_000 tokens.
    expect(result.model_tokens).toBe(50_000);
    expect(result.cost_usd).toBeCloseTo(0.012);
    expect(runtime.run).toHaveBeenCalledTimes(2);
    const secondPrompt = runtime.calls[1]!;
    expect(secondPrompt).toContain("previous materialization was rejected");
    expect(secondPrompt).toContain("copied verbatim");
  });

  it("throws MaterializationError with the accumulated spend when all attempts fail", async () => {
    const runtime = runtimeWith([
      async () => { throw Object.assign(new Error("identity mismatch"), { model_tokens: 10_000, cost_usd: 0.003 }); },
      async () => { throw Object.assign(new Error("identity mismatch again"), { model_tokens: 15_000, cost_usd: 0.004 }); },
      async () => { throw new Error("identity mismatch final"); },
    ]);
    const materializer = new PiExperimentMaterializer(runtime, 3);
    const failure = await materializer.materialize("cwd", snapshot, "node-2222222222222222").then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(MaterializationError);
    expect(failure).toMatchObject({ model_tokens: 25_000, cost_usd: 0.007 });
  });
});