import { clearCachedMessages, clearAiTitle, clearSessionName, type PiScienceClient } from "../../client/pi-science-client";
import { emptyThread, resetTurnBuffer } from "../folding/state";
import { generations, turnState } from "../generations";
import { runtimeStore } from "../store-access";
import { suppressConnectionRecovery } from "./runtime-state";

/**
 * A stale session can survive in a URL or local storage after its JSONL record
 * was removed. Treat that as a recoverable navigation state, not a failed
 * conversation: detach the stream, clear the invalid thread, and leave the
 * workspace on a ready blank composer so the next prompt creates a session.
 */
export function recoverMissingSession(sessionId: string, cwd: string, client?: PiScienceClient): void {
  const current = runtimeStore.getState();
  if (current.cwd !== cwd || (current.activeSessionId !== null && current.activeSessionId !== sessionId)) {
    return;
  }

  ++generations.connection;
  ++generations.promptMonitor;
  ++generations.activity;
  ++generations.localMutation;
  resetTurnBuffer();
  turnState.errored = false;
  if (client?.isConnectedTo(sessionId, cwd)) suppressConnectionRecovery(client, sessionId, cwd);
  client?.disconnect();
  // The session's on-disk record is gone; purge its cached messages and SSE
  // cursor so a later connect to a reused id starts from a clean slate.
  clearCachedMessages(cwd, sessionId);
  client?.clearCursor(cwd, sessionId);
  clearSessionName(cwd, sessionId);
  clearAiTitle(cwd, sessionId);
  runtimeStore.setState({
    activeSessionId: null,
    sessions: current.sessions.filter((session) => session.id !== sessionId),
    thread: emptyThread(),
    historyCursor: null,
    historyHasMore: false,
    historyLoading: false,
    historySnapshotVersion: "",
    working: false,
    turnLifecycle: "settled",
    status: "ready",
    model: null,
    thinking: null,
    contextTokens: null,
    mcpDiagnostics: [],
    contextWindow: null,
    contextPercent: null,
    compactionEnabled: true,
    compactionThresholdPercent: null,
    pendingInteraction: null,
    pendingInteractionQueue: [],
    pendingQuestionnaire: null,
  });
}
