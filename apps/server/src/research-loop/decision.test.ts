import { expect, it } from "vitest";
import type { EvaluatorSpec } from "@pi-science/contracts";
import { researchDecision } from "./decision.js";
import type { ResearchSnapshot } from "./types.js";

it("keeps the measured incumbent and carries reviewer evidence into the next decision", () => {
  const candidate = (id: string, speed: number, quality: number) => ({
    candidate_id: id, loop_id: "loop", status: "evaluated" as const,
    proposal: { approach_summary: id, solution: { path: id, digest: id, entrypoint: "solve.sh" } },
    execution: {}, evaluation_status: "passed" as const,
    evaluation: { metrics: { speed: { value: speed, direction: "minimize" as const, source: "deterministic" as const }, quality: { value: quality, direction: "maximize" as const, source: "deterministic" as const } }, hard_checks: {}, artifact_refs: [], findings: [], model_tokens: 0, cost_usd: 0 },
    created_at: "2026-01-01T00:00:00Z",
  });
  const snapshot = {
    loop: { baseline: { speed: 10, quality: 10 } },
    candidates: [candidate("first", 9, 11), candidate("best", 8, 12), candidate("tradeoff", 7, 10)],
    operations: [],
    records: [{ record_type: "candidate.diagnosed", payload: { findings: [{ summary: "CPU bound" }], next_strategy: "vectorize" } }],
  } as unknown as ResearchSnapshot;
  const evaluator = { metrics: [{ name: "speed", direction: "minimize", weight: 1 }, { name: "quality", direction: "maximize", weight: 2 }] } as EvaluatorSpec;
  const decision = researchDecision(snapshot, evaluator);
  expect(decision.best_candidate_id).toBe("best");
  expect(decision.frontier_candidate_ids).toEqual(["best", "tradeoff"]);
  expect(decision.stagnant_rounds).toBe(1);
  expect(decision.next_strategy).toBe("vectorize");
  expect(decision.last_diagnosis).toEqual(["CPU bound"]);
});
