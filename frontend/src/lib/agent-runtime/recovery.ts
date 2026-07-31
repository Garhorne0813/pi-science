/** Recovery paths: authoritative REST re-reads after a stream gap, a late
 *  stream attach or a transport failure, and the missing-session reset. */

import { clearCachedMessages, clearSessionName, getClient, type PiScienceClient } from "../pi-science-client";
import { emptyThread, mergeHistoryWithLive, resetTurnBuffer, threadFromMessages } from "./event-fold";
import { generations, turnState } from "./generations";
import { backfillSessionName } from "./naming";
import { loadSessionsInternal } from "./sessions";
import { useRuntimeStore } from "./store";

export async function resyncCompletedHistory(sessionId: string, cwd: string): Promise<void> {
  const generation = generations.connection;
  try {
    const messages = await getClient().getMessages(sessionId, cwd);
    const current = useRuntimeStore.getState();
    if (
      generation !== generations.connection
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
      || current.working
    ) return;
    // Restore the REST snapshot wholesale for a settled conversation. The Pi
    // process writes the session JSONL before agent_settled, so a non-empty
    // snapshot is authoritative. Merging live blocks into it would duplicate
    // the turn: live ids (user-<ts>, SSE partId) can never match REST ids
    // (JSONL message ids). Only a racing empty snapshot needs the guard — the
    // file may not have flushed yet, so keep the visible live thread.
    if (messages.length === 0 && current.thread.blocks.length > 0) {
      // The snapshot is stale (file not flushed yet) — keep the live thread.
      return;
    }
    useRuntimeStore.setState({ thread: threadFromMessages(messages) });
  } catch (error) {
    console.error("Failed to resynchronize completed conversation:", error);
  }
}

export async function reconcileWorkingState(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  connectionGeneration: number,
  activityGeneration: number,
): Promise<void> {
  try {
    const runtimeState = await client.getSessionState(sessionId, cwd);
    const current = useRuntimeStore.getState();
    if (
      connectionGeneration !== generations.connection
      || activityGeneration !== generations.activity
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
    ) return;
    useRuntimeStore.setState({
      working: runtimeState.is_streaming
        || runtimeState.is_compacting
        || runtimeState.pending_message_count > 0,
      model: runtimeState.model ?? current.model,
      thinking: runtimeState.thinking ?? current.thinking,
      contextTokens: runtimeState.context_tokens ?? current.contextTokens,
      contextWindow: runtimeState.context_window ?? current.contextWindow,
      contextPercent: runtimeState.context_percent ?? current.contextPercent,
      compactionEnabled: runtimeState.compaction_enabled ?? current.compactionEnabled,
      compactionThresholdPercent: runtimeState.compaction_threshold_percent ?? current.compactionThresholdPercent,
    });
  } catch {
    // Keep the current working state. A stream transport failure must not
    // re-enable Send while the backend may still be executing the turn.
  }
}

/** Recover the authoritative conversation snapshot after a `stream.gap`:
 *  re-read both the message history and the runtime state in parallel, and
 *  base `working` on the authoritative state rather than blindly clearing it.
 *  The new SSE subscription (rebuilt by the client transport) only carries
 *  future events, so this REST snapshot is what restores the visible history. */
export async function reconcileAfterGap(
  sessionId: string,
  cwd: string,
): Promise<void> {
  const client = getClient();
  const [messagesResult, stateResult] = await Promise.allSettled([
    client.getMessages(sessionId, cwd),
    client.getSessionState(sessionId, cwd),
  ]);
  const current = useRuntimeStore.getState();
  if (current.activeSessionId !== sessionId || current.cwd !== cwd) return;

  // Apply the authoritative runtime state BEFORE the history snapshot so we do
  // not clobber a busy flag the backend still holds. A gap during a long tool
  // call must keep Send disabled until the backend reports idle.
  if (stateResult.status === "fulfilled") {
    const runtimeState = stateResult.value;
    useRuntimeStore.setState({
      working: runtimeState.is_streaming
        || runtimeState.is_compacting
        || runtimeState.pending_message_count > 0,
      model: runtimeState.model ?? current.model,
      thinking: runtimeState.thinking ?? current.thinking,
      contextTokens: runtimeState.context_tokens ?? current.contextTokens,
      contextWindow: runtimeState.context_window ?? current.contextWindow,
      contextPercent: runtimeState.context_percent ?? current.contextPercent,
      compactionEnabled: runtimeState.compaction_enabled ?? current.compactionEnabled,
      compactionThresholdPercent: runtimeState.compaction_threshold_percent ?? current.compactionThresholdPercent,
    });
  }
  // History recovery is independent from busy state. Merge the REST snapshot
  // with live blocks so a text.updated arriving during this request is kept.
  if (messagesResult.status === "fulfilled") {
    useRuntimeStore.setState((state) => ({
      thread: mergeHistoryWithLive(threadFromMessages(messagesResult.value), state.thread),
    }));
    backfillSessionName(cwd, sessionId, useRuntimeStore.getState().thread);
  }
  useRuntimeStore.setState({
    status: messagesResult.status === "fulfilled" && stateResult.status === "fulfilled" ? "ready" : "error",
  });
  void loadSessionsInternal();
}

export async function reconcilePromptAfterLateStream(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  monitorGeneration: number,
): Promise<void> {
  let ticks = 0;
  while (true) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    const current = useRuntimeStore.getState();
    if (
      monitorGeneration !== generations.promptMonitor
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
      || !current.working
    ) return;

    ticks += 1;
    const streamOpen = client.isOpenTo(sessionId, cwd);
    if (!streamOpen && ticks % 4 !== 0) continue;

    try {
      const runtimeState = await client.getSessionState(sessionId, cwd);
      const latest = useRuntimeStore.getState();
      if (
        monitorGeneration !== generations.promptMonitor
        || latest.activeSessionId !== sessionId
        || latest.cwd !== cwd
        || !latest.working
      ) return;
      const runtimeWorking = runtimeState.is_streaming
        || runtimeState.is_compacting
        || runtimeState.pending_message_count > 0;
      if (!runtimeWorking) {
        ++generations.activity;
        useRuntimeStore.setState({ working: false, status: "ready", pendingInteraction: null });
        void resyncCompletedHistory(sessionId, cwd);
        void loadSessionsInternal();
        return;
      }
      // Once the stream is open while the runtime is authoritatively busy, its
      // subscriber is attached and will receive the eventual terminal event.
      if (streamOpen) return;
    } catch {
      // Keep polling while the stream is still connecting. Transport failure
      // handling remains responsible for the visible connection status.
    }
  }
}

/**
 * A stale session can survive in a URL or local storage after its JSONL record
 * was removed. Treat that as a recoverable navigation state, not a failed
 * conversation: detach the stream, clear the invalid thread, and leave the
 * workspace on a ready blank composer so the next prompt creates a session.
 */
export function recoverMissingSession(sessionId: string, cwd: string, client?: PiScienceClient): void {
  const current = useRuntimeStore.getState();
  if (current.cwd !== cwd || (current.activeSessionId !== null && current.activeSessionId !== sessionId)) {
    return;
  }

  ++generations.connection;
  ++generations.promptMonitor;
  ++generations.activity;
  ++generations.localMutation;
  resetTurnBuffer();
  turnState.errored = false;
  client?.disconnect();
  // The session's on-disk record is gone; purge its cached messages and SSE
  // cursor so a later connect to a reused id starts from a clean slate.
  clearCachedMessages(cwd, sessionId);
  client?.clearCursor(cwd, sessionId);
  clearSessionName(cwd, sessionId);
  useRuntimeStore.setState({
    activeSessionId: null,
    sessions: current.sessions.filter((session) => session.id !== sessionId),
    thread: emptyThread(),
    working: false,
    status: "ready",
    model: null,
    thinking: null,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    compactionEnabled: true,
    compactionThresholdPercent: null,
    pendingInteraction: null,
  });
}
