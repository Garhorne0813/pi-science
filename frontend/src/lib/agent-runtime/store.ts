/** Runtime composition root: create one Zustand store, compose its actions,
 * then bind imperative access for recovery and listening effects. */

import { create } from "zustand";
import { bindRuntimeStore } from "./store-access";
import { emptyThread } from "./folding/state";
import { createRuntimeActions } from "./session-actions";
import type { RuntimeState } from "./types";

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  status: "offline",
  transportStatus: "idle",
  client: null,
  sessions: [],
  sessionsCursor: null,
  sessionsHasMore: false,
  sessionsLoading: false,
  activeSessionId: null,
  draftModelSelection: null,
  draftApproval: null,
  cwd: ".",
  thread: emptyThread(),
  historyCursor: null,
  historyHasMore: false,
  historyLoading: false,
  historySnapshotVersion: "",
  working: false,
  promptDeliveryNotice: null,
  turnLifecycle: "settled",
  model: null,
  thinking: null,
  contextTokens: null,
  mcpDiagnostics: [],
  contextWindow: null,
  contextPercent: null,
  compactionEnabled: true,
  compactionThresholdPercent: null,
  sessionStats: null,
  pendingInteraction: null,
  pendingInteractionQueue: [],
  pendingQuestionnaire: null,
  fileRevision: 0,
  draft: "",

  ...createRuntimeActions(set, get),
}));

// Bind after action construction; internal effects read the port only on use.
bindRuntimeStore(useRuntimeStore);
