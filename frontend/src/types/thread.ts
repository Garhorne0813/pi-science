/** ThreadBlock types — ported from @ai4s/shared.
 *  These are the data contracts for the conversation UI.
 *  Open-science's rendering components depend on these types. */

// ── Discriminated union of all block types ──

export type ThreadBlock =
  | UserMessageBlock
  | AgentMessageBlock
  | StepSummaryBlock
  | ToolCallBlock
  | ReviewerBlock
  | DataTableBlock
  | FigureBlock
  | ArtifactBlock
  | RunningJobsBlock
  | StatusLineBlock;

export interface UserMessageBlock {
  kind: "user";
  id: string;
  text: string;
  timestamp?: string;
  images?: ImageAttachment[];
}

export interface AgentMessageBlock {
  kind: "agent";
  id: string;
  parts: AgentMessagePart[];
  partial?: boolean;
  timestamp?: string;
  subagentId?: string;
}

export interface AgentMessagePart {
  id: string;
  text: string;
}

export interface StepSummaryBlock {
  kind: "step-summary";
  id: string;
  text: string;
}

export interface ToolCallBlock {
  kind: "tool";
  id: string;
  callId: string;
  tool: string;
  status: ToolStatus;
  title?: string;
  input?: Record<string, unknown>;
  output?: string;
  partialOutput?: string;
  diff?: string;
  startedAt?: string;
  endedAt?: string;
  childSessionId?: string;
}

export type ToolStatus = "running" | "done" | "error" | "waiting-approval";

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

export interface StatusLineBlock {
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

// ── Provenance ──

export interface ProvenanceRecord {
  path: string;
  version: number;
  ts: number;
  tool: string;
  toolCallId?: string;
  sessionId: string;
  model?: string;
  contentHash?: string;
  content?: string;
  diff?: string;
  log?: string;
  runId?: string;
  env?: ProvenanceEnvironment;
}

export interface ProvenanceEnvironment {
  python?: string;
  platform?: string;
  app?: string;
  packages?: { hash: string; count: number };
  packages_hash?: string;
  package_count?: number;
  cpu_count?: number;
  [key: string]: unknown;
}

export interface RunRecord {
  runId: string;
  sessionId?: string;
  command?: string;
  surface: "local" | "hpc" | "ssh";
  status: "ok" | "failed" | "running";
  host?: string;
  startedAt?: string;
  endedAt?: string;
  outputs?: { path: string; hash?: string; size?: number }[];
  code?: string[];
  envFile?: string;
}
