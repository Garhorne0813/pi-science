/** Public state shape of the agent runtime store. */

import type { PiScienceClient, SessionInfo } from "../client/pi-science-client";
import type { Thread } from "./event-fold";

export interface PendingInteraction {
  requestId: string;
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  options?: Array<string | { label?: string; value?: string }>;
  placeholder?: string;
  prefill?: string;
  /** True for the Pi-Science structured questionnaire bridge request. */
  questionnaire?: boolean;
  toolCallId?: string;
}

export interface QuestionnaireOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionnaireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionnaireOption[];
}

export interface PendingQuestionnaire {
  toolCallId: string;
  questions: QuestionnaireQuestion[];
}

export interface RuntimeState {
  // Connection
  status: "connecting" | "ready" | "error" | "offline";
  client: PiScienceClient | null;

  // Session
  sessions: SessionInfo[];
  activeSessionId: string | null;
  cwd: string;

  // Thread
  thread: Thread;
  historyCursor: string | null;
  historyHasMore: boolean;
  historyLoading: boolean;
  historySnapshotVersion: string;
  working: boolean;
  model: string | null;
  thinking: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  compactionEnabled: boolean;
  compactionThresholdPercent: number | null;
  pendingInteraction: PendingInteraction | null;
  pendingQuestionnaire: PendingQuestionnaire | null;
  /** Increments after a turn settles so workspace file views can reload. */
  fileRevision: number;

  // Draft (unsent message)
  draft: string;

  // Actions
  connect: (cwd: string, sessionId?: string) => Promise<void>;
  disconnect: () => void;
  sendPrompt: (message: string) => Promise<string | null>;
  abort: () => Promise<void>;
  setModel: (model: string, thinking?: string) => Promise<string | null>;
  respondToInteraction: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => Promise<void>;
  loadSessions: (cwd?: string) => Promise<SessionInfo[]>;
  loadSession: (sessionId: string) => Promise<void>;
  loadOlderMessages: () => Promise<number>;
  forkSession: (sessionId: string) => Promise<string>;
  createNewSession: () => Promise<string>;
  deleteSession: (sessionId: string) => Promise<void>;
  removeSession: (sessionId: string) => void;
  setDraft: (text: string) => void;
}

export interface SessionReplacement {
  cwd: string;
  oldId: string;
  newId: string;
}
