import type { EvaluatorSpec } from "@pi-science/contracts";
import type { ResearchCandidate, ResearchSnapshot } from "./types.js";

export interface ResearchDecision {
  best_candidate_id: string | null;
  best_score: number | null;
  best_metrics: Record<string, number>;
  frontier_candidate_ids: string[];
  stagnant_rounds: number;
  next_strategy: string | null;
  last_diagnosis: string[];
  recent_failures: Array<{ candidate_id: string; reason: string }>;
}

export function candidateScore(candidate: ResearchCandidate, snapshot: ResearchSnapshot, evaluator: EvaluatorSpec): number {
  const first = snapshot.candidates.find((item) => item.evaluation_status === "passed" && item.evaluation);
  return evaluator.metrics.reduce((sum, spec) => {
    const value = candidate.evaluation?.metrics[spec.name]?.value;
    const base = snapshot.loop?.baseline?.[spec.name] ?? first?.evaluation?.metrics[spec.name]?.value;
    if (value == null || base == null || !Number.isFinite(value) || !Number.isFinite(base)) return sum;
    const gain = (spec.direction === "minimize" ? base - value : value - base) / Math.max(Math.abs(base), 1);
    return sum + gain * (spec.weight ?? 1);
  }, 0);
}

export function stagnantRounds(snapshot: ResearchSnapshot, evaluator: EvaluatorSpec): number {
  const evaluated = snapshot.candidates.filter((candidate) => candidate.evaluation_status === "passed" && candidate.evaluation);
  let best = snapshot.loop?.baseline ? 0 : -Infinity;
  let lastImprovement = -1;
  for (const [index, candidate] of evaluated.entries()) {
    const score = candidateScore(candidate, snapshot, evaluator);
    if (score - best > (snapshot.loop?.stop_conditions?.min_improvement ?? 0)) {
      best = score;
      lastImprovement = index;
    }
  }
  return evaluated.length - 1 - lastImprovement;
}

/** Deterministic evidence summary for the next experiment; the agent proposes,
 * but cannot decide which measurements count or rewrite the incumbent. */
export function researchDecision(snapshot: ResearchSnapshot, evaluator: EvaluatorSpec | null): ResearchDecision {
  const candidates = snapshot.candidates;
  const passed = candidates.filter((candidate) => candidate.evaluation_status === "passed" && candidate.evaluation);
  const specs = evaluator?.metrics ?? [];
  const score = (candidate: ResearchCandidate) => evaluator ? candidateScore(candidate, snapshot, evaluator) : 0;
  const ranked = [...passed].sort((left, right) => score(right) - score(left));
  const best = ranked[0] ?? null;
  const frontier = passed.filter((candidate) => !passed.some((other) => other !== candidate && dominates(other, candidate, specs.map((spec) => spec.name))));
  const diagnoses = snapshot.records.filter((row) => row.record_type === "candidate.diagnosed");
  const lastDiagnosis = diagnoses.at(-1)?.payload;
  const findings = Array.isArray(lastDiagnosis?.findings)
    ? lastDiagnosis.findings.flatMap((item) => item && typeof item === "object" && typeof (item as { summary?: unknown }).summary === "string" ? [(item as { summary: string }).summary] : [])
    : [];
  return {
    best_candidate_id: best?.candidate_id ?? null,
    best_score: best ? score(best) : null,
    best_metrics: best ? Object.fromEntries(Object.entries(best.evaluation!.metrics).map(([name, metric]) => [name, metric.value])) : {},
    frontier_candidate_ids: frontier.map((candidate) => candidate.candidate_id),
    stagnant_rounds: evaluator ? stagnantRounds(snapshot, evaluator) : candidates.length,
    next_strategy: typeof lastDiagnosis?.next_strategy === "string" ? lastDiagnosis.next_strategy : null,
    last_diagnosis: findings,
    recent_failures: candidates.filter((candidate) => candidate.status === "failed" || candidate.evaluation_status === "failed").slice(-3).map((candidate) => ({
      candidate_id: candidate.candidate_id,
      reason: String(candidate.execution.stderr_excerpt ?? candidate.execution.status ?? candidate.evaluation_status ?? "failed").slice(-300),
    })),
  };
}

function dominates(left: ResearchCandidate, right: ResearchCandidate, names: string[]): boolean {
  if (!names.length) return false;
  let strictlyBetter = false;
  for (const name of names) {
    const l = left.evaluation?.metrics[name]; const r = right.evaluation?.metrics[name];
    if (!l || !r || !Number.isFinite(l.value) || !Number.isFinite(r.value)) return false;
    if (l.direction === "minimize" ? l.value > r.value : l.value < r.value) return false;
    if (l.value !== r.value) strictlyBetter = true;
  }
  return strictlyBetter;
}
