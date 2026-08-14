/** Wire types shared by the REST calls, the SSE transport and the runtime store. */

export interface PiScienceEvent {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  project_id?: string | null;
}

export interface AvailableModel {
  id: string;
  provider: string;
  model: string;
  label: string;
  custom?: boolean;
  reasoning?: boolean;
  thinking_levels?: string[];
  context_window?: number | null;
  capability_source?: string;
}

export interface HistoryMessage {
  id: string;
  role: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: string;
  /** Tool-specific metadata persisted by Pi Orbit (toolResult details). */
  details?: unknown;
}

export interface SessionMessagePage {
  messages: HistoryMessage[];
  next_cursor: string | null;
  has_more: boolean;
  snapshot_version: string;
}

export interface SessionUserMessageIndexEntry {
  id: string;
  role?: "user" | "assistant";
  text: string;
  timestamp?: string | null;
  before: string;
}

export interface SessionUserMessageIndex {
  messages: SessionUserMessageIndexEntry[];
  snapshot_version: string;
}

/** Entry shape returned by the server for both user-only and all-role indexes. */
export interface SessionMessageIndexEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: string | null;
  before: string;
}

export interface SessionMessageIndex {
  messages: SessionMessageIndexEntry[];
  snapshot_version: string;
}

export interface TurnArtifactItem {
  path: string;
  kind: string;
  mime: string;
  size: number;
  artifactId?: string;
  version?: number;
}

export interface TurnArtifactTurn {
  turn_id: string;
  session_id: string;
  assistant_message_id: string | null;
  /** 1-based turn ordinal (agent_start count); null for records persisted
   *  before this field existed. Used to anchor the strip to the n-th agent
   *  block on history restore when no assistant message id is available. */
  turn_ordinal: number | null;
  ended_at: string;
  artifacts: TurnArtifactItem[];
}

export interface SessionState {
  id: string;
  cwd: string;
  is_streaming: boolean;
  is_compacting: boolean;
  pending_message_count: number;
  model?: string;
  thinking?: string;
  context_tokens?: number | null;
  context_window?: number | null;
  context_percent?: number | null;
  compaction_enabled?: boolean;
  compaction_threshold_percent?: number | null;
}

export interface InteractionResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}
