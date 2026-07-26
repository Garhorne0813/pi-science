import type { ResearchLoop } from "@pi-science/contracts";
import type { ResearchSnapshot } from "./types.js";

export function activeWallMs(loop: ResearchLoop, now = Date.now()): number {
  if (loop.status !== "running" || !loop.started_at) return loop.active_wall_ms;
  return loop.active_wall_ms + Math.max(0, now - Date.parse(loop.started_at));
}

export function stopReason(snapshot: ResearchSnapshot, now = Date.now()): string | null {
  const loop = snapshot.loop;
  if (!loop) return "loop_missing";
  const lastCandidate = snapshot.candidates.at(-1);
  if (snapshot.candidates.length >= loop.budget.max_candidates
    && lastCandidate && ["failed", "cancelled", "evaluated"].includes(lastCandidate.status)) {
    return "candidate_budget_exhausted";
  }
  if (activeWallMs(loop, now) >= loop.budget.max_wall_seconds * 1000) return "wall_time_budget_exhausted";

  const evaluated = snapshot.candidates.filter((candidate) => candidate.evaluation_status === "passed" && candidate.evaluation);
  // Failed runs still spent tokens; leaving them out under-counts the budget.
  const agentRuns = snapshot.records.filter((record) => ["agent.run_completed", "agent.run_failed"].includes(record.record_type));
  const tokens = agentRuns.reduce((sum, record) => sum + Number(record.payload.model_tokens ?? 0), 0)
    + evaluated.reduce((sum, candidate) => sum + Number(candidate.evaluation?.model_tokens ?? 0), 0);
  const cost = agentRuns.reduce((sum, record) => sum + Number(record.payload.cost_usd ?? 0), 0)
    + evaluated.reduce((sum, candidate) => sum + Number(candidate.evaluation?.cost_usd ?? 0), 0);
  if (loop.budget.max_model_tokens != null && tokens >= loop.budget.max_model_tokens) return "model_token_budget_exhausted";
  if (loop.budget.max_cost_usd != null && cost >= loop.budget.max_cost_usd) return "cost_budget_exhausted";

  const targets = loop.stop_conditions.target_metrics;
  if (evaluated.length && Object.keys(targets).length) {
    const latest = evaluated.at(-1)!.evaluation!.metrics;
    const reached = Object.entries(targets).every(([name, target]) => {
      const metric = latest[name];
      if (!metric || metric.source !== "deterministic") return false;
      return metric.direction === "minimize" ? metric.value <= target : metric.value >= target;
    });
    if (reached) return "target_metrics_reached";
  }

  if (evaluated.length >= loop.stop_conditions.patience + 1) {
    const metricName = Object.keys(evaluated[0]!.evaluation!.metrics)[0];
    if (metricName) {
      const recent = evaluated.slice(-(loop.stop_conditions.patience + 1));
      const first = recent[0]!.evaluation!.metrics[metricName];
      const last = recent.at(-1)!.evaluation!.metrics[metricName];
      if (first && last && first.direction === last.direction && first.source === "deterministic" && last.source === "deterministic") {
        const improvement = first.direction === "minimize" ? first.value - last.value : last.value - first.value;
        if (improvement <= 0 || improvement < loop.stop_conditions.min_improvement) return "patience_exhausted";
      }
    }
  }
  return null;
}
