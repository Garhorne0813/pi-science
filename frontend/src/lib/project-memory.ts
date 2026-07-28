import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiRequest } from "./api";
import { queryClient } from "./query-client";

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

export type ResearchTaskType = "research_loop" | "optimize" | "compare" | "evaluate" | "reproduce";
export type ResearchExecutionKind = "iterative" | "conversation";

export interface ResearchIntentDraft {
  task_type: ResearchTaskType;
  execution_kind: ResearchExecutionKind;
  title: string;
  objective: string;
  metric: string | null;
  direction: "maximize" | "minimize";
  success_criterion: string | null;
  plan_steps: string[];
  budget: ResearchLoop["budget"];
  stop_conditions: { target_metrics: Record<string, number>; patience: number; min_improvement: number };
  instructions: string[];
  conversation_prompt: string | null;
}

export interface ResearchLoop {
  loop_id: string;
  revision: number;
  title: string;
  objective: string;
  task_type?: ResearchTaskType;
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

/** Every project-memory read shares this prefix so one mutation invalidates them all. */
export const projectMemoryKey = (...selector: Array<string | null>) => ["project-memory", ...selector];

function read<T>(queryKey: Array<string | null>, path: string) {
  return { queryKey, queryFn: () => apiRequest<T>(path) };
}

/** Imperative read for non-component callers; shares the cache with the hooks below. */
function get<T>(queryKey: Array<string | null>, path: string): Promise<T> {
  return queryClient.fetchQuery(read<T>(queryKey, path));
}

/** Writes go straight to the transport, then drop the whole resource from cache. */
async function write<T>(path: string, init: RequestInit): Promise<T> {
  const data = await apiRequest<T>(path, init);
  void queryClient.invalidateQueries({ queryKey: projectMemoryKey() });
  return data;
}

const loopsQuery = (cwd: string) => read<{ loops: ResearchLoop[] }>(projectMemoryKey("research-loops", cwd), `/api/project-memory/research-loops?${query(cwd)}`);
const loopQuery = (cwd: string, loopId: string) => read<ResearchLoopDetail>(projectMemoryKey("research-loops", cwd, loopId), `/api/project-memory/research-loops/${loopId}?${query(cwd)}`);

export function useResearchLoops(cwd: string) {
  return useQuery(loopsQuery(cwd));
}

const timelineQuery = (cwd: string) => read<{ timeline: Array<Record<string, unknown>> }>(projectMemoryKey("timeline", cwd), `/api/project-memory/timeline?${query(cwd)}`);

/** Project history: mounted only by the history tab, refetched by its own mutations. */
export function useProjectTimeline(cwd: string) {
  return useQuery(timelineQuery(cwd));
}

export function useResearchLoopDetail(cwd: string, loopId: string | null) {
  // keepPreviousData: switching loops keeps the previous detail on screen until the
  // new one arrives, which is what the manual `setDetail(await …)` flow did.
  return useQuery({ ...loopQuery(cwd, loopId ?? ""), enabled: Boolean(loopId), placeholderData: keepPreviousData });
}

export const projectMemoryApi = {
  overview(cwd: string) {
    return get<ProjectMemoryOverview>(projectMemoryKey("overview", cwd), `/api/project-memory/overview?${query(cwd)}`);
  },
  experiences(cwd: string, loopId?: string) {
    const params = new URLSearchParams({ cwd });
    if (loopId) params.set("loop_id", loopId);
    return get<{ experiences: ExperienceRecord[] }>(projectMemoryKey("experiences", cwd, loopId ?? null), `/api/project-memory/experiences?${params}`);
  },
  loops(cwd: string) {
    return queryClient.fetchQuery(loopsQuery(cwd));
  },
  loop(cwd: string, loopId: string) {
    return queryClient.fetchQuery(loopQuery(cwd, loopId));
  },
  intent(cwd: string, mode: ResearchTaskType, objective: string) {
    return write<{ draft: ResearchIntentDraft; requires_confirmation: boolean; missing_fields: string[] }>(`/api/project-memory/research-loop-intents?${query(cwd)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, objective }),
    });
  },
  createLoop(cwd: string, input: { title: string; objective: string; task_type?: ResearchTaskType; evaluator_ref?: EvaluatorRef; constraints?: string[]; budget?: Partial<ResearchLoop["budget"]>; stop_conditions?: { target_metrics?: Record<string, number>; patience?: number; min_improvement?: number } }) {
    return write<ResearchLoop>(`/api/project-memory/research-loops?${query(cwd)}`, {
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
    return write<Record<string, unknown>>(`/api/project-memory/evaluators?${query(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  },
  preflight(cwd: string, loopId: string) {
    return write<{ ok: boolean; blockers: string[]; loop: ResearchLoop }>(`/api/project-memory/research-loops/${loopId}/preflight?${query(cwd)}`, { method: "POST" });
  },
  action(cwd: string, loopId: string, action: "start" | "pause" | "resume" | "cancel" | "complete") {
    return write<ResearchLoop>(`/api/project-memory/research-loops/${loopId}/${action}?${query(cwd)}`, { method: "POST" });
  },
  frontier(cwd: string, loopId: string) {
    return get<{ frontier: ExperienceRecord[] }>(projectMemoryKey("research-loops", cwd, loopId, "frontier"), `/api/project-memory/research-loops/${loopId}/frontier?${query(cwd)}`);
  },
};
