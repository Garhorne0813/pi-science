/** ThreadBlock and inspector view models owned by the conversation UI. */

// Source-compatibility re-export for older UI imports. Wire/domain contracts
// live in @pi-science/contracts and are parsed at the client boundary.
export type { ExecutionRecord, ProvenanceEnvironment, ProvenanceRecord, ToolPresentation } from "@pi-science/contracts";
import type { ToolPresentation } from "@pi-science/contracts";

/** Identity assigned by the conversation protocol. Legacy history may omit
 * these fields; the presentation adapter keeps that path explicit rather than
 * manufacturing an identity from timestamps or message text. */
export interface ConversationBlockIdentity {
  turnId?: string;
  runId?: string;
  itemId?: string;
  parentItemId?: string;
  revision?: number;
  sequence?: number;
}

// ── Discriminated union of all block types ──

export type ThreadBlock =
  | UserMessageBlock
  | AgentMessageBlock
  | ThinkingBlock
  | StepSummaryBlock
  | ToolCallBlock
  | ReviewerBlock
  | DataTableBlock
  | FigureBlock
  | ArtifactBlock
  | RunningJobsBlock
  | StatusLineBlock
  | TurnArtifactSummaryBlock;

export interface UserMessageBlock extends ConversationBlockIdentity {
  kind: "user";
  id: string;
  text: string;
  timestamp?: string;
  images?: ImageAttachment[];
}

export interface AgentMessageBlock extends ConversationBlockIdentity {
  kind: "agent";
  id: string;
  parts: AgentMessagePart[];
  partial?: boolean;
  presentationRole?: "intermediate" | "final";
  /** How the role was obtained. This is diagnostic metadata and is not shown
   * in the ordinary conversation UI. */
  classificationSource?: "explicit" | "legacy_inferred" | "unknown";
  timestamp?: string;
  subagentId?: string;
}

export interface AgentMessagePart {
  id: string;
  text: string;
}

/** The model's reasoning stream (pi `thinking` content parts). Rendered as a
 *  dim line in the live feed and folded behind the settled summary row. */
export interface ThinkingBlock extends ConversationBlockIdentity {
  kind: "thinking";
  id: string;
  parts: AgentMessagePart[];
  partial?: boolean;
  timestamp?: string;
}

export interface StepSummaryBlock {
  kind: "step-summary";
  id: string;
  text: string;
}

export interface ToolCallBlock extends ConversationBlockIdentity {
  kind: "tool";
  id: string;
  callId: string;
  tool: string;
  status: ToolStatus;
  /** All observed terminal/status transitions for this operation. A later
   * successful retry must not erase the fact that an earlier attempt failed. */
  statusHistory?: ToolStatus[];
  operationId?: string;
  attemptId?: string;
  title?: string;
  presentation?: ToolPresentation;
  input?: Record<string, unknown>;
  output?: string;
  /** Tool-specific metadata from the persisted toolResult message (e.g.
   *  rpiv-todo's task snapshot). Read-only panels rebuild tool state from
   *  this without needing live events. */
  details?: unknown;
  partialOutput?: string;
  diff?: string;
  startedAt?: string;
  endedAt?: string;
  childSessionId?: string;
  interactionResolved?: boolean;
}

export type ToolStatus = "running" | "done" | "error" | "waiting-approval" | "unknown";

export type ActivityPlane = "execution" | "plan-control" | "interaction" | "system";

export interface ToolPresentationPolicy {
  plane: ActivityPlane;
  visibleInCurrentActivity: boolean;
  visibleInExecutionTrace: boolean;
  countsAsOperation: boolean;
}

export interface ReviewerBlock {
  kind: "reviewer";
  id: string;
  text: string;
  subagentId?: string;
}

export interface DataTableBlock {
  kind: "data-table";
  id: string;
  title?: string;
  columns: string[];
  rows: string[][];
}

export interface FigureBlock {
  kind: "figure";
  id: string;
  title?: string;
  mimeType: string;
  data: string; // base64
}

export interface ArtifactBlock {
  kind: "artifact";
  id: string;
  filename: string;
  artifact: ArtifactKind;
  tool: string;
  path?: string;
  language?: string;
  content?: string;
}

export type ArtifactKind =
  | "code"
  | "data"
  | "figure"
  | "model"
  | "report"
  | "notebook"
  | "script"
  | "table"
  | "other";

export interface TurnArtifactItem {
  path: string;
  kind: string;
  mime: string;
  size: number;
  artifactId?: string;
  version?: number;
}

/** Per-turn generated-file summary shown after the final assistant message.
 *  Built from the `turn.artifacts` SSE event and restored from the persisted
 *  turn-artifacts.jsonl on history load. */
export interface TurnArtifactSummaryBlock extends ConversationBlockIdentity {
  kind: "artifact-summary";
  id: string;
  turnId: string;
  assistantMessageId?: string | null;
  /** 1-based turn ordinal when known (live events and new persisted records). */
  turnOrdinal?: number | null;
  artifacts: TurnArtifactItem[];
}

export interface RunningJobsBlock {
  kind: "running-jobs";
  id: string;
  jobs: RunningJob[];
}

export interface RunningJob {
  id: string;
  host: string;
  command: string;
  elapsed: string;
}

export interface StatusLineBlock extends ConversationBlockIdentity {
  kind: "status-line";
  id: string;
  text: string;
  level: "info" | "warn" | "error" | "done";
  artifactId?: string;
  path?: string;
}

// ── Image attachment ──

export interface ImageAttachment {
  data: string;     // base64
  mimeType: string; // e.g., "image/png"
}

// ── Session ──

export interface Session {
  id: string;
  title?: string;
  group?: string;
  blocks: ThreadBlock[];
  inspector?: Inspector;
}

// ── Inspector (extended for compatibility with ported open-science components) ──

export type Inspector =
  | ArtifactInspector
  | NotebookInspector
  | PdfInspector
  | FilePreviewInspector
  | NotebookFileInspector
  | NotebookPanelInspector;

export interface NotebookPanelInspector {
  variant: "notebook-panel";
}

export interface ArtifactInspector {
  variant: "artifact";
  title: string;
  filename: string;
  versions: ArtifactVersion[];
  activeVersion: string;
  inputs?: string[];
  code?: string;
  codeStartLine?: number;
  language?: string;
  executionLog?: string;
  environment?: string;
  messages?: string[];
  reviewPassed?: boolean;
}

export interface ArtifactVersion {
  id?: string;
  label?: string;
  ts?: number;
  tool?: string;
  code?: string;
  content?: string;
  diff?: string;
  executionLog?: string;
  messages?: string[];
  environment?: string;
  reviewPassed?: boolean;
}

export interface NotebookInspector {
  variant: "notebook";
  notebookId: string;
  language: string;
}

export interface FilePreviewInspector {
  variant: "file";
  path: string;
  filename: string;
  artifact?: ArtifactKind;
  language?: string;
  content?: string;
  root?: FileRoot;
  cwd?: string;
}

export interface NotebookFileInspector {
  variant: "notebook-file";
  path: string;
  root?: FileRoot;
  cwd?: string;
}

export interface PdfInspector {
  variant: "pdf";
  path?: string;
  filename?: string;
  url?: string;
  page?: number;
}

export type ArtifactTab = "code" | "environment" | "log" | "messages" | "review" | "provenance";

export type FileRoot = "workspace" | "base";
