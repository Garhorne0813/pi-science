/** Recovery paths: authoritative REST re-reads after a stream gap, a late
 *  stream attach or a transport failure, and the missing-session reset. */

import { clearCachedMessages, clearAiTitle, clearSessionName, getClient, type PiScienceClient, type SessionState } from "../client/pi-science-client";
import { emptyThread, mergeHistoryWithLive, resetTurnBuffer, threadFromMessages } from "./event-fold";
import { attachPersistedTurnArtifacts } from "./turn-artifacts";
import { markWorkspaceFilesChanged } from "./file-revision";
import { generations, turnState } from "./generations";
import { backfillSessionName } from "./naming";
import { loadSessionsInternal } from "./sessions";
import { useRuntimeStore } from "./store";
import { hasActivePendingInteraction, hasPendingInteractionData } from "./types";

const WORKING_STATE_MAX_ATTEMPTS = 3;
const WORKING_STATE_BACKOFF_MS = [0, 100, 250] as const;
const CONNECTION_RECOVERY_MAX_ATTEMPTS = 4;
const CONNECTION_RECOVERY_BACKOFF_MS = [0, 100, 250, 500] as const;

type KnownRuntimeState = { busy: boolean; activityGeneration: number };
type ConnectionRecoveryRun = { connectionGeneration: number; activityGeneration: number; promise: Promise<void> };
const knownRuntimeStates = new WeakMap<PiScienceClient, Map<string, KnownRuntimeState>>();
const connectionRecoveryRuns = new WeakMap<PiScienceClient, Map<string, ConnectionRecoveryRun>>();
const suppressedConnectionRecoveries = new WeakMap<PiScienceClient, Set<string>>();

function runtimeKey(sessionId: string, cwd: string): string {
  return `${cwd}\u0000${sessionId}`;
}

function runtimeBusy(runtimeState: SessionState): boolean {
  return runtimeState.is_streaming
    || runtimeState.is_compacting
    || runtimeState.pending_message_count > 0;
}

function pendingWorkingState(runtimeStateBusy: boolean, current: ReturnType<typeof useRuntimeStore.getState>): boolean {
  const pendingInteraction = hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire);
  const awaitingUserInput = hasActivePendingInteraction(current.pendingInteraction, current.pendingQuestionnaire);
  return pendingInteraction ? !awaitingUserInput : runtimeStateBusy;
}

export function rememberRuntimeState(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  runtimeState: SessionState,
  activityGeneration = generations.activity,
): void {
  const states = knownRuntimeStates.get(client) ?? new Map<string, KnownRuntimeState>();
  states.set(runtimeKey(sessionId, cwd), { busy: runtimeBusy(runtimeState), activityGeneration });
  knownRuntimeStates.set(client, states);
}

function knownRuntimeState(client: PiScienceClient, sessionId: string, cwd: string): KnownRuntimeState | undefined {
  return knownRuntimeStates.get(client)?.get(runtimeKey(sessionId, cwd));
}

export function suppressConnectionRecovery(client: PiScienceClient, sessionId: string, cwd: string): void {
  const suppressed = suppressedConnectionRecoveries.get(client) ?? new Set<string>();
  suppressed.add(runtimeKey(sessionId, cwd));
  suppressedConnectionRecoveries.set(client, suppressed);
}

export function consumeSuppressedConnectionRecovery(client: PiScienceClient, sessionId: string, cwd: string): boolean {
  const suppressed = suppressedConnectionRecoveries.get(client);
  if (!suppressed?.delete(runtimeKey(sessionId, cwd))) return false;
  if (suppressed.size === 0) suppressedConnectionRecoveries.delete(client);
  return true;
}

function applyRuntimeState(runtimeState: SessionState, current = useRuntimeStore.getState()): void {
  useRuntimeStore.setState({
    working: pendingWorkingState(runtimeBusy(runtimeState), current),
    model: runtimeState.model ?? current.model,
    thinking: runtimeState.thinking ?? current.thinking,
    contextTokens: runtimeState.context_tokens ?? current.contextTokens,
    contextWindow: runtimeState.context_window ?? current.contextWindow,
    contextPercent: runtimeState.context_percent ?? current.contextPercent,
    compactionEnabled: runtimeState.compaction_enabled ?? current.compactionEnabled,
    compactionThresholdPercent: runtimeState.compaction_threshold_percent ?? current.compactionThresholdPercent,
  });
}

function waitForRecovery(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => globalThis.setTimeout(resolve, ms)) : Promise.resolve();
}

export async function resyncCompletedHistory(sessionId: string, cwd: string): Promise<void> {
  const generation = generations.connection;
  try {
    const history = await getClient().getMessagesPage(sessionId, cwd);
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
    if (history.messages.length === 0 && current.thread.blocks.length > 0) {
      // The snapshot is stale (file not flushed yet) — keep the live thread.
      return;
    }
    useRuntimeStore.setState({
      thread: await attachPersistedTurnArtifacts(threadFromMessages(history.messages), sessionId, cwd),
      historyCursor: history.next_cursor,
      historyHasMore: history.has_more,
      historyLoading: false,
      historySnapshotVersion: history.snapshot_version,
    });
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
  for (let attempt = 0; attempt < WORKING_STATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const runtimeState = await client.getSessionState(sessionId, cwd);
      const current = useRuntimeStore.getState();
      if (
        connectionGeneration !== generations.connection
        || activityGeneration !== generations.activity
        || current.activeSessionId !== sessionId
        || current.cwd !== cwd
      ) return;
      rememberRuntimeState(client, sessionId, cwd, runtimeState, activityGeneration);
      applyRuntimeState(runtimeState, current);
      return;
    } catch {
      // A state request failure is retryable. It is not evidence of an idle
      // runtime, so do not clear working until a bounded retry gets an
      // authoritative answer (or a same-generation known idle snapshot exists
      // for the final fallback below).
      if (attempt + 1 < WORKING_STATE_MAX_ATTEMPTS) {
        await waitForRecovery(WORKING_STATE_BACKOFF_MS[attempt + 1] ?? WORKING_STATE_BACKOFF_MS.at(-1)!);
      }
    }
  }

  const current = useRuntimeStore.getState();
  if (
    connectionGeneration !== generations.connection
    || activityGeneration !== generations.activity
    || current.activeSessionId !== sessionId
    || current.cwd !== cwd
  ) return;
  const known = knownRuntimeState(client, sessionId, cwd);
  if (known?.activityGeneration !== activityGeneration) return;
  if (known.busy) {
    // A previous authoritative busy result remains the safe answer when all
    // retry requests fail: never re-enable Send while the runtime may run.
    applyRuntimeState({
      id: sessionId,
      cwd,
      is_streaming: true,
      is_compacting: false,
      pending_message_count: 0,
    }, current);
  } else if (!hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire)) {
    // Only an authoritative idle snapshot from this activity generation may
    // settle a failed probe. An unknown state must remain conservatively busy.
    useRuntimeStore.setState({ working: false });
    markWorkspaceFilesChanged();
  }
}

/** Recover the authoritative conversation snapshot after a connection loss.
 *  Each bounded round reads messages and runtime state together. The history
 *  read repairs a missed terminal event while the state read is the sole
 *  authority for the composer guard; failures back off instead of treating an
 *  unavailable endpoint as idle. */
async function runConnectionRecovery(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  connectionGeneration: number,
  activityGeneration: number,
): Promise<void> {
  let lastState: SessionState | undefined;
  let historySucceeded = false;
  let stateSucceeded = false;

  for (let attempt = 0; attempt < CONNECTION_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
    const [historyResult, stateResult] = await Promise.allSettled([
      client.getMessagesPage(sessionId, cwd),
      client.getSessionState(sessionId, cwd),
    ]);
    const current = useRuntimeStore.getState();
    if (
      connectionGeneration !== generations.connection
      || activityGeneration !== generations.activity
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
    ) return;

    historySucceeded = historyResult.status === "fulfilled";
    stateSucceeded = stateResult.status === "fulfilled";
    if (stateResult.status === "fulfilled") {
      const runtimeState = stateResult.value;
      lastState = runtimeState;
      rememberRuntimeState(client, sessionId, cwd, runtimeState, activityGeneration);
      applyRuntimeState(runtimeState, useRuntimeStore.getState());
    }
    if (historyResult.status === "fulfilled") {
      const history = historyResult.value;
      const restored = mergeHistoryWithLive(await attachPersistedTurnArtifacts(threadFromMessages(history.messages), sessionId, cwd), useRuntimeStore.getState().thread);
      useRuntimeStore.setState({
        thread: restored,
        historyCursor: history.next_cursor,
        historyHasMore: history.has_more,
        historyLoading: false,
        historySnapshotVersion: history.snapshot_version,
      });
      backfillSessionName(cwd, sessionId, useRuntimeStore.getState().thread);
    }
    if (historySucceeded && stateSucceeded) {
      useRuntimeStore.setState({ status: "ready" });
      // The connection was restored after a loss: files may have changed
      // while the stream was down and no terminal event reached the tree.
      markWorkspaceFilesChanged();
      void loadSessionsInternal();
      return;
    }
    if (attempt + 1 < CONNECTION_RECOVERY_MAX_ATTEMPTS) {
      await waitForRecovery(CONNECTION_RECOVERY_BACKOFF_MS[attempt + 1] ?? CONNECTION_RECOVERY_BACKOFF_MS.at(-1)!);
    }
  }

  const current = useRuntimeStore.getState();
  if (
    connectionGeneration !== generations.connection
    || activityGeneration !== generations.activity
    || current.activeSessionId !== sessionId
    || current.cwd !== cwd
  ) return;
  // Keep whatever authoritative half succeeded. If the last state read was
  // idle and no interaction is pending, settling is safe even when the history
  // endpoint stayed unavailable. If state never succeeded, preserve working.
  if (lastState) applyRuntimeState(lastState, current);
  if (lastState && !runtimeBusy(lastState) && !hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire)) {
    useRuntimeStore.setState({ working: false });
    markWorkspaceFilesChanged();
  } else if (!stateSucceeded) {
    const known = knownRuntimeState(client, sessionId, cwd);
    if (known?.activityGeneration === activityGeneration && !known.busy && !hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire)) {
      useRuntimeStore.setState({ working: false });
      markWorkspaceFilesChanged();
    }
  }
  useRuntimeStore.setState({ status: "error" });
}

export function reconcileAfterConnectionLoss(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  connectionGeneration: number,
  activityGeneration: number,
): Promise<void> {
  const key = runtimeKey(sessionId, cwd);
  const runs = connectionRecoveryRuns.get(client) ?? new Map<string, ConnectionRecoveryRun>();
  const existing = runs.get(key);
  if (
    existing
    && existing.connectionGeneration === connectionGeneration
    && existing.activityGeneration === activityGeneration
  ) return existing.promise;
  const promise = runConnectionRecovery(client, sessionId, cwd, connectionGeneration, activityGeneration);
  runs.set(key, { connectionGeneration, activityGeneration, promise });
  connectionRecoveryRuns.set(client, runs);
  void promise.finally(() => {
    if (runs.get(key)?.promise === promise) runs.delete(key);
    if (runs.size === 0) connectionRecoveryRuns.delete(client);
  }).catch(() => undefined);
  return promise;
}

/** Recover the authoritative conversation snapshot after a `stream.gap`:"}]} Беларусь.functions.edit  code...  (json) $1? Wrong? Tool output omitted? Need see. ["}]} NakneАҞӘА 全民彩票天天атәуп 天天彩票网.functions.edit  code￣色жәк 彩神争霸输钱json  suliaq  񟿿 เกมสล็อตԥсҭазаара? Unclear JSON valid? Actually tool returned? Need inspect. Wait no output likely? Let's check. уҳәа. [
 *  re-read both the message history and the runtime state in parallel, and
 *  base `working` on the authoritative state rather than blindly clearing it.
 *  The new SSE subscription (rebuilt by the client transport) only carries
 *  future events, so this REST snapshot is what restores the visible history. */
export async function reconcileAfterGap(
  sessionId: string,
  cwd: string,
): Promise<void> {
  const client = getClient();
  const activityGeneration = generations.activity;
  const [historyResult, stateResult] = await Promise.allSettled([
    client.getMessagesPage(sessionId, cwd),
    client.getSessionState(sessionId, cwd),
  ]);
  const current = useRuntimeStore.getState();
  if (current.activeSessionId !== sessionId || current.cwd !== cwd) return;

  // Apply the authoritative runtime state BEFORE the history snapshot so we do
  // not clobber a busy flag the backend still holds. A gap during a long tool
  // call must keep Send disabled until the backend reports idle.
  if (stateResult.status === "fulfilled") {
    rememberRuntimeState(client, sessionId, cwd, stateResult.value, activityGeneration);
    if (activityGeneration === generations.activity) applyRuntimeState(stateResult.value, useRuntimeStore.getState());
  }
  // History recovery is independent from busy state. Merge the REST snapshot
  // with live blocks so a text.updated arriving during this request is kept.
  if (historyResult.status === "fulfilled") {
    const merged = mergeHistoryWithLive(await attachPersistedTurnArtifacts(threadFromMessages(historyResult.value.messages), sessionId, cwd), useRuntimeStore.getState().thread);
    useRuntimeStore.setState({
      thread: merged,
      historyCursor: historyResult.value.next_cursor,
      historyHasMore: historyResult.value.has_more,
      historyLoading: false,
      historySnapshotVersion: historyResult.value.snapshot_version,
    });
    backfillSessionName(cwd, sessionId, useRuntimeStore.getState().thread);
  }
  useRuntimeStore.setState({
    status: historyResult.status === "fulfilled" && stateResult.status === "fulfilled" ? "ready" : "error",
  });
  void loadSessionsInternal();
}

/** How many consecutive one-second idle REST rounds with no confirmed reply
 *  before the late-stream monitor gives up and settles the UI anyway. Each
 *  idle round performs a state read and, when idle, an additional messages
 *  read. A finished turn with no output or a wedged agent must not leave Send
 *  disabled forever. */
const DEFAULT_IDLE_LIMIT_TICKS = 120;

export async function reconcilePromptAfterLateStream(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  monitorGeneration: number,
  promptTimestamp?: number,
  idleLimitTicks = DEFAULT_IDLE_LIMIT_TICKS,
  expectedActivityGeneration?: number,
): Promise<void> {
  let ticks = 0;
  let idleTicks = 0;
  let forcedReconnect = false;
  while (true) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    const current = useRuntimeStore.getState();
    if (
      monitorGeneration !== generations.promptMonitor
      || (expectedActivityGeneration !== undefined && expectedActivityGeneration !== generations.activity)
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
      || !current.working
    ) return;

    ticks += 1;
    const streamOpen = client.isOpenTo(sessionId, cwd);
    // An OPEN EventSource is not proof that bytes are still flowing: laptops
    // waking from sleep and old-session switches can leave a half-open socket.
    // Probe REST once per second in either connection state. If an apparently
    // open stream has produced no terminal event, rebuild it once with its
    // resume cursor so missed text/tool/idle events can be replayed.
    if (ticks % 4 !== 0) continue;
    if (streamOpen && !forcedReconnect) {
      forcedReconnect = true;
      client.reconnect(sessionId, cwd);
    }

    try {
      const runtimeState = await client.getSessionState(sessionId, cwd);
      const latest = useRuntimeStore.getState();
      if (
        monitorGeneration !== generations.promptMonitor
        || (expectedActivityGeneration !== undefined && expectedActivityGeneration !== generations.activity)
        || latest.activeSessionId !== sessionId
        || latest.cwd !== cwd
        || !latest.working
      ) return;
      const runtimeWorking = runtimeState.is_streaming
        || runtimeState.is_compacting
        || runtimeState.pending_message_count > 0;
      const pendingInteraction = hasPendingInteractionData(latest.pendingInteraction, latest.pendingQuestionnaire);
      const awaitingUserInput = hasActivePendingInteraction(latest.pendingInteraction, latest.pendingQuestionnaire);
      if (awaitingUserInput) {
        // Pi keeps its stream marked busy while it is paused inside the
        // interaction request. The prompt is the work the user needs to do,
        // so clear the spinner state but keep both pending payloads intact.
        ++generations.activity;
        useRuntimeStore.setState({ working: false, status: "ready" });
        return;
      }
      if (pendingInteraction) {
        // The questionnaire payload and its matching extension UI request are
        // delivered as separate events. Keep the turn busy until the pair is
        // complete so an idle-looking intermediate state cannot clear the
        // payload or re-enable the composer.
        return;
      }
      if (!runtimeWorking) {
        // Authoritative idle is not proof the turn finished: an agent can be
        // briefly idle between tool calls. Only settle once THIS turn's reply
        // is visible in the persisted history (an assistant message written
        // after the prompt was sent) — otherwise an early resync could drop
        // the late reply. Without a prompt baseline (defensive), never assume
        // a reply; the idle cap settles the monitor either way.
        const replyConfirmed = promptTimestamp !== undefined
          && await turnHasNewAssistantReply(client, sessionId, cwd, promptTimestamp);
        if (!replyConfirmed) {
          idleTicks += 1;
          if (idleTicks < idleLimitTicks) continue;
        }
        // Re-check before settling: the reply confirmation awaited a REST
        // round, during which the monitor may have been superseded or the
        // turn resumed working.
        const recheck = useRuntimeStore.getState();
        if (
          monitorGeneration !== generations.promptMonitor
          || (expectedActivityGeneration !== undefined && expectedActivityGeneration !== generations.activity)
          || recheck.activeSessionId !== sessionId
          || recheck.cwd !== cwd
          || !recheck.working
        ) return;
        ++generations.activity;
        useRuntimeStore.setState({ working: false, status: "ready", pendingInteraction: null, pendingQuestionnaire: null });
        void resyncCompletedHistory(sessionId, cwd);
        void loadSessionsInternal();
        return;
      }
      idleTicks = 0;
    } catch {
      // Keep polling while the stream is still connecting. Transport failure
      // handling remains responsible for the visible connection status.
    }
  }
}

/** True when the persisted conversation already contains an assistant message
 *  written after the prompt was sent — i.e. this turn produced a reply that a
 *  history resync will find. The scan starts from the newest message; an
 *  assistant message without a parseable timestamp cannot be attributed to
 *  this turn and counts as unconfirmed. */
async function turnHasNewAssistantReply(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  promptTimestamp: number,
): Promise<boolean> {
  try {
    const page = await client.getMessagesPage(sessionId, cwd);
    const messages = page.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role !== "assistant") continue;
      const timestamp = messages[i].timestamp;
      if (!timestamp) return false;
      const parsed = Date.parse(timestamp);
      if (Number.isNaN(parsed)) return false;
      return parsed > promptTimestamp;
    }
    return false;
  } catch {
    return false;
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
  if (client?.isConnectedTo(sessionId, cwd)) suppressConnectionRecovery(client, sessionId, cwd);
  client?.disconnect();
  // The session's on-disk record is gone; purge its cached messages and SSE
  // cursor so a later connect to a reused id starts from a clean slate.
  clearCachedMessages(cwd, sessionId);
  client?.clearCursor(cwd, sessionId);
  clearSessionName(cwd, sessionId);
  clearAiTitle(cwd, sessionId);
  useRuntimeStore.setState({
    activeSessionId: null,
    sessions: current.sessions.filter((session) => session.id !== sessionId),
    thread: emptyThread(),
    historyCursor: null,
    historyHasMore: false,
    historyLoading: false,
    historySnapshotVersion: "",
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
    pendingQuestionnaire: null,
  });
}
