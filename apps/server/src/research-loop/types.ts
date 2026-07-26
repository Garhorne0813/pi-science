import type {
  CandidateEvaluation,
  CandidateProposal,
  ResearchLoop,
} from "@pi-science/contracts";

export interface ResearchRecord {
  schema_version: 2;
  record_id: string;
  record_type: string;
  workspace_id: string;
  loop_id?: string;
  candidate_id?: string;
  operation_id?: string;
  run_id?: string;
  created_at: string;
  producer: string;
  causation_id?: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export interface ResearchOperation {
  operation_id: string;
  kind: "agent" | "execution" | "evaluation";
  phase: string;
  status: "reserved" | "started" | "completed" | "failed" | "cancelled" | "lost";
  loop_id: string;
  candidate_id?: string;
  run_id?: string;
  attempt: number;
  idempotency_key: string;
  error?: string;
  result?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ResearchCandidate {
  candidate_id: string;
  loop_id: string;
  status: "proposed" | "executing" | "succeeded" | "failed" | "cancelled" | "evaluated";
  proposal: CandidateProposal & { solution: { path: string; digest: string; entrypoint: string } };
  execution: Record<string, unknown>;
  evaluation: CandidateEvaluation | null;
  evaluation_status: "passed" | "failed" | null;
  created_at: string;
}

export interface ResearchSnapshot {
  loop: ResearchLoop | null;
  candidates: ResearchCandidate[];
  operations: ResearchOperation[];
  records: ResearchRecord[];
}

export interface AgentRunRequest {
  operation_id: string;
  loop: ResearchLoop;
  phase: "candidate" | "analysis";
  context: Record<string, unknown>;
}

export interface AgentRunResult {
  run_id: string;
  session_id?: string;
  async_dir?: string;
  output: Record<string, unknown>;
  model_tokens: number;
  cost_usd: number;
}

export interface ResearchSubagentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
  status(runId: string): Promise<"running" | "completed" | "failed" | "lost">;
  cancel(runId: string): Promise<void>;
  shutdown(): Promise<void>;
}
