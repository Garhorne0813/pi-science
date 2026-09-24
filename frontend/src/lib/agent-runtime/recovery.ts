/** Recovery paths: authoritative REST re-reads after a stream gap, a late
 *  stream attach or a transport failure, and the missing-session reset. */

import { clearCachedMessages, clearAiTitle, clearSessionName, getClient, type PiScienceClient, type SessionState } from "../client/pi-science-client";
import { isMissingSessionError } from "./errors";
import { attachTurnArtifacts, emptyThread, resetTurnBuffer, type Thread } from "./event-fold";
import { markWorkspaceFilesChanged } from "./file-revision";
import { generations, turnState } from "./generations";
import { mergeRecoveryHistoryWindow } from "./history-window-recovery";
import { backfillSessionName } from "./naming";
import { loadSessionsInternal } from "./sessions";
import { useRuntimeStore } from "./store";
import { applyTransportEvent } from "./transport-status";
import { fetchPersistedTurnArtifacts, refetchPersistedTurnArtifacts } from "./turn-artifacts";
import { hasActivePendingInteraction, hasPendingInteractionData } from "./types";

const WORKING_STATE_MAX_ATTEMPTS = 3;
const WORKING_STATE_BACKOFF_MS = [0, 100, 250] as const;
const CONNECTION_RECOVERY_MAX_ATTEMPTS = 4;
const CONNECTION_RECOVERY_BACKOFF_MS = [0, 100, 250, 500] as const;
const MAX_GAP_RECOVERY_ROUNDS = 3;
const GAP_RECOVERY_BACKOFF_MS = [0, 100, 250] as const;

type KnownRuntimeState = { busy: boolean; activityGeneration: number };
type ConnectionRecoveryRun = { connectionGeneration: number; activityGeneration: number; promise: Promise<void> };
type GapRecoveryResult = "completed" | "superseded" | "aborted" | "retryable-failure";
interface GapRecoveryRun {
  promise: Promise<void>;
  rerunRequested: boolean;
  rounds: number;
  resetTransport: boolean;
  reconnectTransport: boolean;
}
const knownRuntimeStates = new WeakMap<PiScienceClient, Map<string, KnownRuntimeState>>();
const connectionRecoveryRuns = new WeakMap<PiScienceClient, Map<string, ConnectionRecoveryRun>>();
const gapRecoveryRuns = new Map<string, GapRecoveryRun>();
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
  const working = pendingWorkingState(runtimeBusy(runtimeState), current);
  useRuntimeStore.setState({
    working,
    turnLifecycle: working ? (hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire) ? "waiting" : "active") : current.turnLifecycle,
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
  const conversationGeneration = generations.conversation;
  const activityGeneration = generations.activity;
  const metadataGeneration = generations.presentationMetadata;
  try {
    const client = getClient();
    const [historyResult, artifactsResult] = await Promise.allSettled([
      client.getMessagesPage(sessionId, cwd),
      fetchPersistedTurnArtifacts(sessionId, cwd),
    ]);
    const current = useRuntimeStore.getState();
    if (historyResult.status !== "fulfilled") return;
    if (
      generation !== generations.connection
      || conversationGeneration !== generations.conversation
      || activityGeneration !== generations.activity
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
      || current.working
    ) return;
    const history = historyResult.value;
    // Restore the REST snapshot wholesale for a settled conversation. The Pi
    // process writes the session JSONL before agent_settled, so a non-empty
    // snapshot is authoritative. An empty snapshot can still race the flush.
    if (history.messages.length === 0 && current.thread.blocks.length > 0) return;
    let turns = artifactsResult.status === "fulfilled" ? artifactsResult.value : [];
    // A latest page can move completely beyond the already loaded window after
    // a long tool-heavy turn. Walk older pages until lineage is established;
    // only a complete no-overlap history may replace the window wholesale.
    const historyWindowGeneration = generations.historyWindow;
    const merged = await mergeRecoveryHistoryWindow(client, sessionId, cwd, current.thread, history, { keepLiveExtras: false, resetProjection: true });
    let latest = useRuntimeStore.getState();
    if (
      generation !== generations.connection
      || conversationGeneration !== generations.conversation
      || activityGeneration !== generations.activity
      || historyWindowGeneration !== generations.historyWindow
      || latest.activeSessionId !== sessionId
      || latest.cwd !== cwd
      || latest.working
    ) return;
    // The settle event can precede the messages endpoint's view of the user
    // write. Keep that prompt at its turn boundary while accepting any new
    // assistant/tool records from the snapshot; a later refresh replaces it
    // once the durable user row with the same request identity arrives.
    const restoredThread = retainUnmatchedPrompt(merged.thread, latest.thread);
    if (metadataGeneration !== generations.presentationMetadata) {
      try {
        const persistedTurns = await refetchPersistedTurnArtifacts(sessionId, cwd);
        latest = useRuntimeStore.getState();
        turns = mergeArtifactTurns(persistedTurns, liveArtifactTurns(latest.thread, sessionId));
      } catch (error) {
        // Conversation history is the primary recovery result. When the
        // metadata refresh is unavailable, use only the latest live summaries:
        // reusing the first (older) snapshot could resurrect a removed strip.
        console.warn("Failed to refresh conversation metadata during history resync:", error);
        latest = useRuntimeStore.getState();
        turns = liveArtifactTurns(latest.thread, sessionId);
      }
      latest = useRuntimeStore.getState();
      if (
        generation !== generations.connection
        || conversationGeneration !== generations.conversation
        || activityGeneration !== generations.activity
        || historyWindowGeneration !== generations.historyWindow
        || latest.activeSessionId !== sessionId
        || latest.cwd !== cwd
        || latest.working
      ) return;
    }
    const historyHasMore = merged.retainedOlderPrefix ? latest.historyHasMore : merged.boundaryPage.has_more;
    useRuntimeStore.setState({
      thread: attachTurnArtifacts(restoredThread, turns, { windowComplete: !historyHasMore }),
      historyCursor: merged.retainedOlderPrefix ? latest.historyCursor : merged.boundaryPage.next_cursor,
      historyHasMore,
      historyLoading: false,
      historySnapshotVersion: history.snapshot_version,
    });
  } catch (error) {
    console.error("Failed to resynchronize completed conversation:", error);
  }
}

function retainUnmatchedPrompt(history: Thread, live: Thread): Thread {
  const promptIndex = live.blocks.findLastIndex((block) => block.kind === "user" && block.client_message_id);
  if (promptIndex < 0) return history;
  const prompt = live.blocks[promptIndex];
  if (prompt.kind !== "user" || history.blocks.some((block) => block.kind === "user"
    && (block.client_message_id === prompt.client_message_id || block.id === prompt.id))) return history;
  const preceding = live.blocks.slice(0, promptIndex).findLast((block) => history.index[block.id] !== undefined);
  const insertAt = preceding ? history.index[preceding.id] + 1 : 0;
  const blocks = [...history.blocks];
  blocks.splice(insertAt, 0, prompt);
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { ...history, blocks, index };
}

function liveArtifactTurns(thread: ReturnType<typeof useRuntimeStore.getState>["thread"], sessionId: string) {
  return thread.blocks.flatMap((block) => block.kind === "artifact-summary" ? [{
    turn_id: block.turnId,
    session_id: sessionId,
    assistant_message_id: block.assistantMessageId ?? null,
    turn_ordinal: block.turnOrdinal ?? null,
    ended_at: block.endedAt ?? "",
    artifacts: block.artifacts,
  }] : []);
}

export function mergeArtifactTurns(
  persisted: Awaited<ReturnType<typeof fetchPersistedTurnArtifacts>>,
  live: Awaited<ReturnType<typeof fetchPersistedTurnArtifacts>>,
) {
  const byTurn = new Map(persisted.map((turn) => [turn.turn_id, turn]));
  for (const turn of live) {
    const previous = byTurn.get(turn.turn_id);
    // The live turn is newer for its artifact list and ordinal, but a copy
    // rebuilt from a legacy block may carry no turn end time. Letting it
    // replace the persisted copy outright strands the strip: the record has no
    // assistant message id and an opaque turn id, so the end time is the only
    // anchor left, and an unresolvable anchor is dropped from a partial history
    // window instead of being placed by position.
    byTurn.set(
      turn.turn_id,
      previous && !turn.ended_at ? { ...turn, ended_at: previous.ended_at } : turn,
    );
  }
  return [...byTurn.values()];
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
        useRuntimeStore.setState({ working: false, turnLifecycle: "settled" });
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
    const [historyResult, stateResult, artifactsResult] = await Promise.allSettled([
      client.getMessagesPage(sessionId, cwd),
      client.getSessionState(sessionId, cwd),
      fetchPersistedTurnArtifacts(sessionId, cwd),
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
      const turns = artifactsResult.status === "fulfilled" ? artifactsResult.value : [];
      const historyWindowGeneration = generations.historyWindow;
      const merged = await mergeRecoveryHistoryWindow(client, sessionId, cwd, useRuntimeStore.getState().thread, history, { keepLiveExtras: true });
      const latest = useRuntimeStore.getState();
      if (
        connectionGeneration !== generations.connection
        || activityGeneration !== generations.activity
        || historyWindowGeneration !== generations.historyWindow
        || latest.activeSessionId !== sessionId
        || latest.cwd !== cwd
      ) return;
      const historyHasMore = merged.retainedOlderPrefix ? latest.historyHasMore : merged.boundaryPage.has_more;
      const restored = attachTurnArtifacts(merged.thread, turns, { windowComplete: !historyHasMore });
      useRuntimeStore.setState({
        thread: restored,
        historyCursor: merged.retainedOlderPrefix ? latest.historyCursor : merged.boundaryPage.next_cursor,
        historyHasMore,
        historyLoading: false,
        historySnapshotVersion: history.snapshot_version,
      });
      backfillSessionName(cwd, sessionId, useRuntimeStore.getState().thread);
    }
    if (historySucceeded && stateSucceeded) {
      // Authoritative recovery succeeded: the session is usable again, so the
      // foreground returns to ready without ever having shown a repair phase.
      applyTransportEvent({ transport: "open", reason: "recovery", foreground: "ready", sessionId });
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
    useRuntimeStore.setState({ working: false, turnLifecycle: "settled" });
    markWorkspaceFilesChanged();
  } else if (!stateSucceeded) {
    const known = knownRuntimeState(client, sessionId, cwd);
    if (known?.activityGeneration === activityGeneration && !known.busy && !hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire)) {
      useRuntimeStore.setState({ working: false, turnLifecycle: "settled" });
      markWorkspaceFilesChanged();
    }
  }
  // Bounded recovery gave up: only now is the session advertised as unusable.
  applyTransportEvent({ transport: "error", reason: "recovery", foreground: "error", sessionId });
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

/** Recover the authoritative conversation snapshot after a `stream.gap`:
 *  re-read both the message history and the runtime state in parallel, and
 *  base `working` on the authoritative state rather than blindly clearing it.
 *  The new SSE subscription (rebuilt by the client transport) only carries
 *  future events, so this REST snapshot is what restores the visible history. */
function gapRecoveryInvalidation(
  sessionId: string,
  cwd: string,
  connectionGeneration: number,
  conversationGeneration: number,
  activityGeneration: number,
  historyWindowGeneration: number,
): "superseded" | "aborted" | null {
  const current = useRuntimeStore.getState();
  if (
    connectionGeneration !== generations.connection
    || current.activeSessionId !== sessionId
    || current.cwd !== cwd
  ) return "aborted";
  if (
    conversationGeneration !== generations.conversation
    || activityGeneration !== generations.activity
    || historyWindowGeneration !== generations.historyWindow
  ) return "superseded";
  return null;
}

async function runGapRecoveryRound(
  sessionId: string,
  cwd: string,
  resetTransport: boolean,
  reconnectTransport: boolean,
): Promise<GapRecoveryResult> {
  const client = getClient();
  const connectionGeneration = generations.connection;
  const conversationGeneration = generations.conversation;
  const activityGeneration = generations.activity;
  const historyWindowGeneration = generations.historyWindow;
  const [historyResult, stateResult, artifactsResult] = await Promise.allSettled([
    client.getMessagesPage(sessionId, cwd),
    client.getSessionState(sessionId, cwd),
    fetchPersistedTurnArtifacts(sessionId, cwd),
  ]);
  const invalidation = gapRecoveryInvalidation(
    sessionId,
    cwd,
    connectionGeneration,
    conversationGeneration,
    activityGeneration,
    historyWindowGeneration,
  );
  if (invalidation) return invalidation;
  const missingSession = [historyResult, stateResult].some(
    (result) => result.status === "rejected" && isMissingSessionError(result.reason),
  );
  if (missingSession) {
    recoverMissingSession(sessionId, cwd, client);
    return "aborted";
  }
  const current = useRuntimeStore.getState();

  // Apply the authoritative runtime state BEFORE the history snapshot so we do
  // not clobber a busy flag the backend still holds. A gap during a long tool
  // call must keep Send disabled until the backend reports idle.
  if (stateResult.status === "fulfilled") {
    rememberRuntimeState(client, sessionId, cwd, stateResult.value, activityGeneration);
    if (conversationGeneration === generations.conversation && activityGeneration === generations.activity) {
      applyRuntimeState(stateResult.value, useRuntimeStore.getState());
    }
  }
  // History recovery is authoritative. Any real conversation activity that
  // arrives while this request is in flight invalidates the run below, so an
  // old snapshot cannot overwrite the newer live projection.
  if (historyResult.status === "fulfilled") {
    // An empty snapshot can still race the session's first flush, so it must
    // not replace a thread that already holds live content — same guard as
    // resyncCompletedHistory. The round is a no-op rather than a failure: the
    // gap-recovery retry budget is far shorter than the window in which the
    // messages become visible, and the settle-time resync rebases the thread
    // once they do.
    if (historyResult.value.messages.length === 0 && current.thread.blocks.length > 0) return "completed";
    const turns = artifactsResult.status === "fulfilled" ? artifactsResult.value : [];
    const merged = await mergeRecoveryHistoryWindow(client, sessionId, cwd, current.thread, historyResult.value, { keepLiveExtras: false, resetProjection: true });
    const mergeInvalidation = gapRecoveryInvalidation(
      sessionId,
      cwd,
      connectionGeneration,
      conversationGeneration,
      activityGeneration,
      historyWindowGeneration,
    );
    if (mergeInvalidation) return mergeInvalidation;
    const latest = useRuntimeStore.getState();
    const historyHasMore = merged.retainedOlderPrefix ? latest.historyHasMore : merged.boundaryPage.has_more;
    const restored = attachTurnArtifacts(merged.thread, turns, { windowComplete: !historyHasMore });
    useRuntimeStore.setState({
      thread: restored,
      historyCursor: merged.retainedOlderPrefix ? latest.historyCursor : merged.boundaryPage.next_cursor,
      historyHasMore,
      historyLoading: false,
      historySnapshotVersion: historyResult.value.snapshot_version,
    });
    backfillSessionName(cwd, sessionId, useRuntimeStore.getState().thread);
  }
  const recoveryStatus = historyResult.status === "fulfilled" && stateResult.status === "fulfilled" ? "ready" : "error";
  if (resetTransport && historyResult.status === "fulfilled" && stateResult.status === "fulfilled") {
    // The old cursor is precisely what caused this recovery. Drop it only
    // after the authoritative projection has been installed, then start a
    // fresh live subscription. A later server gap remains recoverable and is
    // coalesced by the single-flight wrapper below.
    const resumeCursor = await client.getConversationResumeCursor(sessionId, cwd).catch(() => null);
    const cursorInvalidation = gapRecoveryInvalidation(
      sessionId,
      cwd,
      connectionGeneration,
      conversationGeneration,
      activityGeneration,
      historyWindowGeneration,
    );
    if (cursorInvalidation) return cursorInvalidation;
    client.clearCursor(cwd, sessionId);
    client.setResumeCursor(cwd, sessionId, resumeCursor);
    if (reconnectTransport && client.isConnectedTo(sessionId, cwd)) client.reconnect(sessionId, cwd, "stream_gap");
  }
  // Record the finished round after the intentional reconnect so its
  // synchronous connection.connecting notification cannot mask the result.
  applyTransportEvent({
    transport: recoveryStatus === "ready" ? "open" : "error",
    reason: "stream_gap",
    ...(recoveryStatus === "ready" ? { foreground: "ready" as const } : {}),
    sessionId,
    detail: "authoritative projection rebased",
  });
  void loadSessionsInternal();
  return recoveryStatus === "ready" ? "completed" : "retryable-failure";
}

async function runGapRecoveryWorker(sessionId: string, cwd: string, run: GapRecoveryRun): Promise<void> {
  while (run.rounds < MAX_GAP_RECOVERY_ROUNDS) {
    run.rounds += 1;
    run.rerunRequested = false;
    await waitForRecovery(GAP_RECOVERY_BACKOFF_MS[run.rounds - 1] ?? GAP_RECOVERY_BACKOFF_MS.at(-1)!);
    const result = await runGapRecoveryRound(sessionId, cwd, run.resetTransport, run.reconnectTransport);
    if (result === "aborted") return;

    const current = useRuntimeStore.getState();
    const stillNeedsRecovery = current.activeSessionId === sessionId
      && current.cwd === cwd
      && current.thread.foldState?.reconciliationRequired === true;
    if (
      result === "superseded"
      || result === "retryable-failure"
      || run.rerunRequested
      || stillNeedsRecovery
    ) continue;
    return;
  }
  if (useRuntimeStore.getState().activeSessionId === sessionId && useRuntimeStore.getState().cwd === cwd) {
    applyTransportEvent({ transport: "error", reason: "stream_gap", foreground: "error", sessionId, detail: "gap recovery exhausted" });
  }
}

/** Single-flight authoritative recovery for both explicit server gaps and
 * client-detected sequence/epoch discontinuities. Multiple out-of-order
 * events from one broken stream must not start competing REST rebases. */
export function reconcileAfterGap(
  sessionId: string,
  cwd: string,
  options: { resetTransport?: boolean; reconnectTransport?: boolean } = {},
): Promise<void> {
  const key = runtimeKey(sessionId, cwd);
  const existing = gapRecoveryRuns.get(key);
  if (existing) {
    existing.rerunRequested = true;
    existing.resetTransport ||= options.resetTransport === true;
    existing.reconnectTransport ||= options.reconnectTransport === true;
    return existing.promise;
  }
  const run: GapRecoveryRun = {
    promise: Promise.resolve(),
    rerunRequested: false,
    rounds: 0,
    resetTransport: options.resetTransport === true,
    reconnectTransport: options.reconnectTransport === true,
  };
  const promise = runGapRecoveryWorker(sessionId, cwd, run);
  run.promise = promise;
  gapRecoveryRuns.set(key, run);
  void promise.finally(() => {
    if (gapRecoveryRuns.get(key) === run) gapRecoveryRuns.delete(key);
  }).catch(() => undefined);
  return promise;
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
      client.reconnect(sessionId, cwd, "late_stream_probe");
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
        useRuntimeStore.setState({ working: false, turnLifecycle: "waiting", status: "ready" });
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
        useRuntimeStore.setState({ working: false, turnLifecycle: "settled", status: "ready", pendingInteraction: null, pendingQuestionnaire: null });
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
 *  this turn and counts as unconfirmed.
 *
 *  Commentary is not an answer. An agent narrates between tool calls and can
 *  fall briefly idle, so a newest explicitly intermediate message must never
 *  confirm the reply: settling on it would drop the final answer that arrives
 *  afterwards. Only that explicit negative guard exists — final messages and
 *  legacy unclassified messages keep the timestamp rule, because a legacy
 *  runtime never classified its messages. */
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
      if (messages[i].presentationRole === "intermediate") return false;
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
    turnLifecycle: "settled",
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
