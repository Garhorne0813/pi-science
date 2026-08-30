/** Agent Runtime Store — manages pi agent session state.
 *  Rewrite of open-science's useRuntimeStore for the pi-science backend.
 *
 *  This module owns nothing but the store instance: the initial state and the
 *  actions built by ./session-actions. The helper modules in this folder read
 *  and write the store through the handle exported here. */

import { create } from "zustand";
import { emptyThread } from "./event-fold";
import { createRuntimeActions } from "./session-actions";
import type { RuntimeState } from "./types";

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  status: "offline",
  client: null,
  sessions: [],
  activeSessionId: null,
  cwd: ".",
  thread: emptyThread(),
  historyCursor: null,
  historyHasMore: false,
  historyLoading: false,
  historySnapshotVersion: "",
  working: false,
  turnLifecycle: "settled",
  model: null,
  thinking: null,
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  compactionEnabled: true,
  compactionThresholdPercent: null,
  sessionStats: null,
  pendingInteraction: null,
  pendingQuestionnaire: null,
  fileRevision: 0,
  draft: "",

  ...createRuntimeActions(set, get),
}));
