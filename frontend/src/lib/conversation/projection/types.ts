import type { ImageAttachment } from "../../../types/thread";
import type { TurnLifecycle } from "../turn-presentation";

export type ProjectionSessionState = "idle" | "running" | "waiting_user" | "recovering" | "error";

export interface RevisionedProjection {
  id: string;
  /** UI-local monotonic version token. Adapters may derive it from either an
   * entity revision or a stream-global sequence; it is not a wire revision or
   * an optimistic-concurrency token. */
  revision: number;
}

export interface ConversationProjection {
  /** Missing on legacy history; `legacy` is an explicit compatibility epoch. */
  streamEpoch: string;
  throughSeq: number;
  turns: TurnProjection[];
  activeTurnId?: string;
  sessionState: ProjectionSessionState;
}

export interface TurnProjection extends RevisionedProjection {
  lifecycle: TurnLifecycle;
  user: UserMessageProjection | null;
  activities: ActivityProjection[];
  interactions: InteractionProjection[];
  answer?: AnswerProjection;
  artifacts: ArtifactProjection[];
  researchRuns: ResearchRunProjection[];
}

export interface UserMessageProjection extends RevisionedProjection {
  text: string;
  timestamp?: string;
  images?: ImageAttachment[];
}

export type ActivityKind =
  | "tool"
  | "kernel"
  | "literature"
  | "dataset"
  | "file"
  | "environment"
  | "subagent"
  | "research"
  | "process_summary"
  | "unknown";

export type ActivityState = "input_streaming" | "queued" | "waiting_approval" | "running" | "success" | "error" | "cancelled";

export interface StructuredProgress {
  phase?: string;
  label?: string;
  current?: number;
  total?: number;
  unit?: string;
  percent?: number;
  indeterminate?: boolean;
}

export interface ActivityProjection extends RevisionedProjection {
  kind: ActivityKind;
  state: ActivityState;
  title: string;
  subtitle?: string;
  toolName?: string;
  progress?: StructuredProgress;
  inputSummary?: unknown;
  outputSummary?: unknown;
  detailRef?: string;
  startedAt?: string;
  endedAt?: string;
  presentation?: {
    renderer?: string;
    groupKey?: string;
    importance?: "normal" | "high";
  };
}

export interface InteractionOption {
  id: string;
  label: string;
  value?: unknown;
}

export interface InteractionProjection extends RevisionedProjection {
  kind: "permission" | "question" | "confirmation";
  state: "pending" | "submitted" | "expired" | "cancelled";
  title: string;
  description?: string;
  options?: InteractionOption[];
  relatedActivityId?: string;
}

export interface AnswerProjection extends RevisionedProjection {
  role: "provisional" | "final";
  state: "streaming" | "complete" | "interrupted" | "error";
  markdown: string;
}

export type ArtifactKind = "image" | "table" | "dataset" | "notebook" | "molecule" | "structure" | "code" | "document" | "file";

export interface ArtifactPreview {
  kind: string;
  uri?: string;
  thumbnailUri?: string;
}

export interface ArtifactProjection extends RevisionedProjection {
  version?: number;
  filename: string;
  path?: string;
  kind: ArtifactKind;
  mime?: string;
  size?: number;
  sha256?: string;
  state: "declared" | "writing" | "published" | "failed";
  generatedBy?: {
    turnId?: string;
    activityId?: string;
    executionId?: string;
  };
  environmentRevision?: string;
  preview?: ArtifactPreview;
  provenanceRef?: string;
}

export interface ResearchCandidateSummary {
  id: string;
  label?: string;
  metric?: number;
  state: "queued" | "running" | "complete" | "failed" | "cancelled";
}

export interface ResearchRunProjection extends RevisionedProjection {
  state: "queued" | "running" | "paused" | "complete" | "failed" | "cancelled";
  phase?: string;
  evaluated: number;
  total?: number;
  bestMetric?: {
    name: string;
    value: number;
    direction?: "min" | "max";
  };
  elapsedMs?: number;
  candidates?: ResearchCandidateSummary[];
}
