/** Bounded authoritative rebasing after a sequence or epoch discontinuity. */
import { getClient } from "../../client/pi-science-client";
import { isMissingSessionError } from "../errors";
import { attachTurnArtifacts } from "../folding/artifacts";
import { generations } from "../generations";
import { mergeRecoveryHistoryWindow } from "../history-window-recovery";
import { backfillSessionName } from "../naming";
import { loadSessionsInternal } from "../sessions";
import { runtimeStore } from "../store-access";
import { applyTransportEvent } from "../transport-status";
import { fetchPersistedTurnArtifacts } from "../turn-artifacts";
import type { GapRecoveryResult, GapRecoveryRun } from "./types";
import { applyRuntimeState, rememberRuntimeState } from "./runtime-state";
import { recoverMissingSession } from "./missing-session";
import { runtimeKey } from "./identity";
import { waitForRecovery } from "./timing";

const MAX_GAP_RECOVERY_ROUNDS = 3;

const GAP_RECOVERY_BACKOFF_MS = [0, 100, 250] as const;

const gapRecoveryRuns = new Map<string, GapRecoveryRun>();

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
  const current = runtimeStore.getState();
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
  const current = runtimeStore.getState();

  // Apply the authoritative runtime state BEFORE the history snapshot so we do
  // not clobber a busy flag the backend still holds. A gap during a long tool
  // call must keep Send disabled until the backend reports idle.
  if (stateResult.status === "fulfilled") {
    rememberRuntimeState(client, sessionId, cwd, stateResult.value, activityGeneration);
    if (conversationGeneration === generations.conversation && activityGeneration === generations.activity) {
      applyRuntimeState(stateResult.value, runtimeStore.getState());
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
    const latest = runtimeStore.getState();
    const historyHasMore = merged.retainedOlderPrefix ? latest.historyHasMore : merged.boundaryPage.has_more;
    const restored = attachTurnArtifacts(merged.thread, turns, { windowComplete: !historyHasMore });
    runtimeStore.setState({
      thread: restored,
      historyCursor: merged.retainedOlderPrefix ? latest.historyCursor : merged.boundaryPage.next_cursor,
      historyHasMore,
      historyLoading: false,
      historySnapshotVersion: historyResult.value.snapshot_version,
    });
    backfillSessionName(cwd, sessionId, runtimeStore.getState().thread);
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

    const current = runtimeStore.getState();
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
  if (runtimeStore.getState().activeSessionId === sessionId && runtimeStore.getState().cwd === cwd) {
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
