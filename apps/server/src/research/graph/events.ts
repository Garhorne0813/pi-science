import type {
  AutoResearchBudget,
  AutoResearchSnapshot,
  AutoResearchUsage,
  ClaimEvidence,
  ResearchClaim,
  ResearchEdge,
  ResearchEvidence,
  ResearchNode,
  ResearchGraphStatus,
} from "@pi-science/contracts";

export interface ResearchCreatedPayload {
  project_id: string;
  origin_session_id: string | null;
  origin_message_id: string | null;
  title: string;
  objective: string;
  constraints: string[];
  budget: AutoResearchBudget;
  target_metrics: AutoResearchSnapshot["target_metrics"];
  question: ResearchNode;
}

export interface ResearchMutationPayload {
  nodes_created?: ResearchNode[];
  nodes_updated?: ResearchNode[];
  edges_created?: ResearchEdge[];
  claims_created?: ResearchClaim[];
  evidence_created?: ResearchEvidence[];
  claim_evidence_created?: ClaimEvidence[];
  status?: ResearchGraphStatus;
  current_activity?: string | null;
  best_result?: Record<string, unknown> | null;
  usage?: Partial<AutoResearchUsage>;
  stop_reason?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  constraints?: string[];
}

export interface ResearchGraphEvent {
  schema_version: 1;
  event_id: string;
  research_id: string;
  revision: number;
  type:
    | "research.created"
    | "research.started"
    | "research.commit.accepted"
    | "research.mutated"
    | "research.constraint.updated"
    | "research.input.resolved"
    | "research.completed"
    | "research.failed"
    | "research.cancelled";
  timestamp: string;
  producer: string;
  commit_id?: string;
  operation_id?: string;
  payload: ResearchCreatedPayload | ResearchMutationPayload;
}
