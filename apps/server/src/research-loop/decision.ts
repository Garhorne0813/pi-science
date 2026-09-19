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

/** Deterministic evidence summary for the next experiment; the agent proposes,
 * but cannot decide which measurements count or rewrite the incumbent. */
export function researchDecision(snapshot: ResearchSnapshot, evaluator: EvaluatorSpec | null): ResearchDecision {
  const candidates = snapshot.candidates;
  const passed = candidates.filter((candidate) => candidate.evaluation_status === "passed" && candidate.evaluation);
  const specs = evaluator?.metrics ?? [];
  const reference = Object.fromEntries(specs.map((spec) => [spec.name,
    snapshot.loop?.baseline?.[spec.name] ?? passed[0]?.evaluation?.metrics[spec.name]?.value ?? 0,
  ]));
  const score = (candidate: ResearchCandidate) => specs.reduce((sum, spec) => {
    const value = candidate.evaluation?.metrics[spec.name]?.value;
    const base = reference[spec.name];
    if (value == null || base == null || !Number.isFinite(value)) return sum;
    const gain = (spec.direction === "minimize" ? base - value : value - base) / Math.max(Math.abs(base), 1);
    return sum + gain * (spec.weight ?? 1);
  }, 0);
  const ranked = [...passed].sort((left, right) => score(right) - score(left));
  const best = ranked[0] ?? null;
  const frontier = passed.filter((candidate) => !passed.some((other) => other !== candidate && dominates(other, candidate, specs.map((spec) => spec.name))));
  const lastImprovementIndex = best ? candidates.findIndex((candidate) => candidate.candidate_id === best.candidate_id) : -1;
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
    stagnant_rounds: best ? candidates.length - 1 - lastImprovementIndex : candidates.length,
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
