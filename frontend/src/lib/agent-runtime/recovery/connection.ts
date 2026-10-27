/** A shared single-flight worker arbitrates restore and connection-loss demands. */
import { getClient, type PiScienceClient, type SessionMessagePage, type SessionState, type TurnArtifactTurn } from "../../client/pi-science-client";
import { attachTurnArtifacts } from "../folding/artifacts";
import { markWorkspaceFilesChanged } from "../file-revision";
import { generations } from "../generations";
import { mergeRecoveryHistoryWindow } from "../history-window-recovery";
import { backfillSessionName } from "../naming";
import { loadSessionsInternal } from "../sessions";
import { runtimeStore } from "../store-access";
import { applyTransportEvent } from "../transport-status";
import { fetchPersistedTurnArtifacts } from "../turn-artifacts";
import { hasPendingInteractionData } from "../types";
import type { ConnectionRecoveryRun, RecoveryKind } from "./types";
import { applyRuntimeState, confirmedIdleLifecycle, knownRuntimeState, rememberRuntimeState } from "./runtime-state";
import { runtimeBusy, runtimeKey } from "./identity";
import { waitForRecovery } from "./timing";

const CONNECTION_RECOVERY_MAX_ATTEMPTS = 4;

const CONNECTION_RECOVERY_BACKOFF_MS = [0, 100, 250, 500] as const;

const RESTORE_RECOVERY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;

const connectionRecoveryRuns = new WeakMap<PiScienceClient, Map<string, ConnectionRecoveryRun>>();

/** Recover the authoritative conversation snapshot. The state read is the sole
 *  authority for the composer guard and the history read repairs a terminal
 *  event no live event carried; failures back off instead of treating an
 *  unavailable endpoint as idle. Each round serves the most urgent demand
 *  still outstanding, and the run ends only when none is left. */
async function runConnectionRecovery(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  run: ConnectionRecoveryRun,
): Promise<void> {
  const { connectionGeneration, activityGeneration, localMutationGeneration, demands } = run;
  let lastState: SessionState | undefined;
  let stateSucceeded = false;
  /** A restore round that saw an authoritative busy snapshot with its history
   *  applied. Later busy rounds watch the runtime state alone, because from
   *  then on the live stream owns history and only the settle round reads it. */
  let busySnapshotReady = false;

  const ownsFence = () => {
    const current = runtimeStore.getState();
    return connectionGeneration === generations.connection
      && activityGeneration === generations.activity
      && localMutationGeneration === generations.localMutation
      && getClient() === client && current.activeSessionId === sessionId && current.cwd === cwd;
  };
  const ownsRecovery = (kind: RecoveryKind) => ownsFence() && (kind === "connection-loss" || runtimeStore.getState().working);
  // A loss is verified even when the composer looks free, because a stale idle
  // is exactly what it is there to disprove.
  const urgentDemand = (): RecoveryKind => demands.has("connection-loss") ? "connection-loss" : "restore";
  for (let attempt = 0; attempt < CONNECTION_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
    if (demands.size === 0) return;
    // One retry budget for both kinds. A loss probes at once; jitter spreads
    // the slower restore probes from tabs that were restored at the same time.
    const scheduled = urgentDemand();
    if (!ownsRecovery(scheduled)) return;
    const delay = scheduled === "restore"
      ? RESTORE_RECOVERY_BACKOFF_MS[attempt]! * (0.8 + Math.random() * 0.4)
      : CONNECTION_RECOVERY_BACKOFF_MS[attempt]!;
    if (delay > 0) await waitForRecovery(delay, run);
    // A demand that joined during the wait takes this round when it is more
    // urgent, and a restore whose gate closed while waiting must not run it.
    const kind = urgentDemand();
    if (!ownsRecovery(kind)) return;
    // A loss and the first restore round rebuild the whole snapshot, because
    // the connect-time read may have failed. A later busy restore round reads
    // the state first, since that read alone decides whether history is due.
    let stateResult: PromiseSettledResult<SessionState>;
    let historyResult: PromiseSettledResult<SessionMessagePage> | null = null;
    let artifactsResult: PromiseSettledResult<TurnArtifactTurn[]> | null = null;
    if (kind === "connection-loss" || !busySnapshotReady) {
      [historyResult, stateResult, artifactsResult] = await Promise.allSettled([
        client.getMessagesPage(sessionId, cwd),
        client.getSessionState(sessionId, cwd),
        fetchPersistedTurnArtifacts(sessionId, cwd),
      ]);
    } else {
      [stateResult] = await Promise.allSettled([client.getSessionState(sessionId, cwd)]);
      // The snapshot turned idle: this is when a terminal outcome that no live
      // event carried becomes visible, so read the history one last time.
      if (stateResult.status === "fulfilled" && !runtimeBusy(stateResult.value)) {
        [historyResult, artifactsResult] = await Promise.allSettled([
          client.getMessagesPage(sessionId, cwd),
          fetchPersistedTurnArtifacts(sessionId, cwd),
        ]);
      }
    }
    const current = runtimeStore.getState();
    if (
      connectionGeneration !== generations.connection
      || activityGeneration !== generations.activity
      || localMutationGeneration !== generations.localMutation
      || getClient() !== client
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
    ) return;

    stateSucceeded = stateResult.status === "fulfilled";
    if (stateResult.status === "fulfilled") {
      const runtimeState = stateResult.value;
      lastState = runtimeState;
      rememberRuntimeState(client, sessionId, cwd, runtimeState, activityGeneration);
      applyRuntimeState(runtimeState, runtimeStore.getState());
    }
    if (historyResult?.status === "fulfilled") {
      const history = historyResult.value;
      const turns = artifactsResult?.status === "fulfilled" ? artifactsResult.value : [];
      const historyWindowGeneration = generations.historyWindow;
      const merged = await mergeRecoveryHistoryWindow(client, sessionId, cwd, runtimeStore.getState().thread, history, { keepLiveExtras: true });
      const latest = runtimeStore.getState();
      if (
        connectionGeneration !== generations.connection
        || activityGeneration !== generations.activity
        || localMutationGeneration !== generations.localMutation
        || getClient() !== client
        || historyWindowGeneration !== generations.historyWindow
        || latest.activeSessionId !== sessionId
        || latest.cwd !== cwd
      ) return;
      const historyHasMore = merged.retainedOlderPrefix ? latest.historyHasMore : merged.boundaryPage.has_more;
      const restored = attachTurnArtifacts(merged.thread, turns, { windowComplete: !historyHasMore });
      runtimeStore.setState({
        thread: restored,
        historyCursor: merged.retainedOlderPrefix ? latest.historyCursor : merged.boundaryPage.next_cursor,
        historyHasMore,
        historyLoading: false,
        historySnapshotVersion: history.snapshot_version,
      });
      backfillSessionName(cwd, sessionId, runtimeStore.getState().thread);
    }
    // A watch round needs no history: the state read alone decides whether the
    // demand this round serves is answered.
    const roundAnswered = stateSucceeded && (historyResult === null || historyResult.status === "fulfilled");
    if (roundAnswered) {
      // History may carry an explicit failed/aborted result absent before merge.
      if (lastState) applyRuntimeState(lastState, runtimeStore.getState());
      // Authoritative recovery succeeded: the session is usable again, so the
      // foreground returns to ready without ever having shown a repair phase.
      applyTransportEvent({ transport: "open", reason: "recovery", foreground: "ready", sessionId });
      // The connection was restored after a loss: files may have changed
      // while the stream was down and no terminal event reached the tree.
      markWorkspaceFilesChanged();
      void loadSessionsInternal();
      if (kind === "restore" && lastState && runtimeBusy(lastState)) busySnapshotReady = true;
      // A busy restore keeps its demand: only an authoritatively free composer
      // retires it. Every other round answers the demand that ordered it.
      if (kind === "connection-loss" || !runtimeStore.getState().working) demands.delete(kind);
      if (demands.size === 0 || attempt + 1 === CONNECTION_RECOVERY_MAX_ATTEMPTS) return;
    }
  }

  const current = runtimeStore.getState();
  if (
    connectionGeneration !== generations.connection
    || activityGeneration !== generations.activity
      || localMutationGeneration !== generations.localMutation
      || getClient() !== client
    || current.activeSessionId !== sessionId
    || current.cwd !== cwd
  ) return;
  // Keep whatever authoritative half succeeded. If the last state read was
  // idle and no interaction is pending, settling is safe even when the history
  // endpoint stayed unavailable. If state never succeeded, preserve working.
  if (lastState) applyRuntimeState(lastState, current);
  if (lastState && !runtimeBusy(lastState) && !hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire)) {
    runtimeStore.setState({ working: false, turnLifecycle: confirmedIdleLifecycle(current.thread, current.turnLifecycle) });
    markWorkspaceFilesChanged();
  } else if (!stateSucceeded) {
    const known = knownRuntimeState(client, sessionId, cwd);
    if (known?.activityGeneration === activityGeneration && !known.busy && !hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire)) {
      runtimeStore.setState({ working: false, turnLifecycle: confirmedIdleLifecycle(current.thread, current.turnLifecycle) });
      markWorkspaceFilesChanged();
    }
  }
  // Bounded recovery gave up: only now is the session advertised as unusable.
  applyTransportEvent({ transport: "error", reason: "recovery", foreground: "error", sessionId });
}

function startConnectionRecovery(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  connectionGeneration: number,
  activityGeneration: number,
  localMutationGeneration = generations.localMutation,
  request: RecoveryKind = "connection-loss",
): Promise<void> {
  const key = runtimeKey(sessionId, cwd);
  const runs = connectionRecoveryRuns.get(client) ?? new Map<string, ConnectionRecoveryRun>();
  const existing = runs.get(key);
  if (
    existing
    && existing.connectionGeneration === connectionGeneration
    && existing.activityGeneration === activityGeneration
    && existing.localMutationGeneration === localMutationGeneration
  ) {
    existing.demands.add(request);
    existing.wake?.();
    return existing.promise;
  }
  const run: ConnectionRecoveryRun = {
    connectionGeneration,
    activityGeneration,
    localMutationGeneration,
    demands: new Set([request]),
    wake: null,
    promise: Promise.resolve(),
  };
  const promise = runConnectionRecovery(client, sessionId, cwd, run);
  run.promise = promise;
  runs.set(key, run);
  connectionRecoveryRuns.set(client, runs);
  void promise.finally(() => {
    if (runs.get(key)?.promise === promise) runs.delete(key);
    if (runs.size === 0) connectionRecoveryRuns.delete(client);
  }).catch(() => undefined);
  return promise;
}

export function reconcileAfterConnectionLoss(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  connectionGeneration: number,
  activityGeneration: number,
): Promise<void> {
  return startConnectionRecovery(client, sessionId, cwd, connectionGeneration, activityGeneration);
}

/** Restore uses the shared recovery worker with a single four-probe budget.
 * Busy and unavailable snapshots back off; only authoritative idle unlocks.
 * Ownership fences cancel retries after live activity or user mutations. */
export function reconcileRestoredSession(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  connectionGeneration: number,
  activityGeneration: number,
  localMutationGeneration: number,
): Promise<void> {
  return startConnectionRecovery(client, sessionId, cwd, connectionGeneration, activityGeneration, localMutationGeneration, "restore");
}
