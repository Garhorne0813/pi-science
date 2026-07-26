import { apiRequest, invalidateApiCache } from "./api";

export interface ProjectMemoryOverview {
  workspace: string;
  project_file: string;
  pending_count: number;
  knowledge_count: number;
  auto_review: boolean;
  run_count: number;
  artifact_count: number;
  result_review_count: number;
  research_record_count: number;
  research_loop_count: number;
  active_research_loop_count: number;
}

export interface EvaluatorRef {
  evaluator_id: string;
  version: number;
  digest: string;
}

export interface ResearchLoop {
  loop_id: string;
  revision: number;
  title: string;
  objective: string;
  status: "draft" | "ready" | "running" | "pausing" | "paused" | "cancelling" | "completed" | "failed" | "cancelled" | "needs_attention";
  mode: "serial";
  evaluator_ref?: EvaluatorRef | null;
  budget: {
    max_candidates: number;
    max_wall_seconds: number;
    max_model_tokens?: number | null;
    max_cost_usd?: number | null;
    max_parallel: number;
  };
  constraints: string[];
  created_at: string;
  updated_at: string;
  stop_reason?: string | null;
  started_at?: string | null;
  active_wall_ms?: number;
}

export interface ExperienceRecord {
  loop_id: string;
  candidate_id: string;
  status: string;
  proposal: { approach_summary: string };
  execution: Record<string, unknown>;
  evaluation: { metrics?: Record<string, { value: number; direction: string }>; artifact_refs?: Array<Record<string, unknown>> } | null;
  evaluation_status?: "passed" | "failed" | null;
  created_at: string;
}

export interface ResearchLoopDetail extends ResearchLoop {
  candidates: ExperienceRecord[];
  operations: Array<{ operation_id: string; phase: string; status: string; updated_at: string; error?: string }>;
  frontier: ExperienceRecord[];
}

function query(cwd: string) {
  return new URLSearchParams({ cwd }).toString();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const data = await apiRequest<T>(path, { ...init, cacheTtlMs: init?.method ? 0 : 3000 });
  if (init?.method && init.method !== "GET") invalidateApiCache("/api/project-memory/");
  return data;
}

export const projectMemoryApi = {
  overview(cwd: string) {
    return request<ProjectMemoryOverview>(`/api/project-memory/overview?${query(cwd)}`);
  },
  timeline(cwd: string) {
    return request<{ timeline: Array<Record<string, unknown>> }>(`/api/project-memory/timeline?${query(cwd)}`);
  },
  experiences(cwd: string, loopId?: string) {
    const params = new URLSearchParams({ cwd });
    if (loopId) params.set("loop_id", loopId);
    return request<{ experiences: ExperienceRecord[] }>(`/api/project-memory/experiences?${params}`);
  },
  loops(cwd: string) {
    return request<{ loops: ResearchLoop[] }>(`/api/project-memory/research-loops?${query(cwd)}`);
  },
  loop(cwd: string, loopId: string) {
    return request<ResearchLoopDetail>(`/api/project-memory/research-loops/${loopId}?${query(cwd)}`);
  },
  intent(cwd: string, objective: string) {
    return request<{ draft: { title: string; objective: string; budget: ResearchLoop["budget"] }; requires_confirmation: boolean }>(`/api/project-memory/research-loop-intents?${query(cwd)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ objective }),
    });
  },
  createLoop(cwd: string, input: { title: string; objective: string; evaluator_ref?: EvaluatorRef; constraints?: string[]; budget?: Partial<ResearchLoop["budget"]>; stop_conditions?: { target_metrics?: Record<string, number>; patience?: number; min_improvement?: number } }) {
    return request<ResearchLoop>(`/api/project-memory/research-loops?${query(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  },
  registerEvaluator(cwd: string, input: {
    evaluator_id: string;
    version: number;
    digest: string;
    status: "approved";
    metrics: Array<{ name: string; direction: "maximize" | "minimize"; weight: number; source?: "deterministic" | "llm_judged" }>;
    hard_checks: string[];
    command?: string[];
  }) {
    return request<Record<string, unknown>>(`/api/project-memory/evaluators?${query(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  },
  preflight(cwd: string, loopId: string) {
    return request<{ ok: boolean; blockers: string[]; loop: ResearchLoop }>(`/api/project-memory/research-loops/${loopId}/preflight?${query(cwd)}`, { method: "POST" });
  },
  action(cwd: string, loopId: string, action: "start" | "pause" | "resume" | "cancel" | "complete") {
    return request<ResearchLoop>(`/api/project-memory/research-loops/${loopId}/${action}?${query(cwd)}`, { method: "POST" });
  },
  frontier(cwd: string, loopId: string) {
    return request<{ frontier: ExperienceRecord[] }>(`/api/project-memory/research-loops/${loopId}/frontier?${query(cwd)}`);
  },
};
