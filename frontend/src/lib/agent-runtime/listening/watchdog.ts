/** One silence timer probes the active turn with identity and generation fences. */
import { markWorkspaceFilesChanged } from "../file-revision";
import { bumpConversationGeneration, generations, turnState } from "../generations";
import { resyncCompletedHistory } from "../recovery/settled-history";
import { hasActivePendingInteraction } from "../types";
import { runtimeStore } from "../store-access";
import { listenerBinding } from "./binding";

/** A live turn whose event stream goes silent must not latch "Working"
 *  forever: an open EventSource is not proof that bytes still flow, and the
 *  prompt-time monitor exits as soon as the first live event arrives. While
 *  a turn is live this watchdog tracks the last event arrival; on silence it
 *  reconnects the stream once (the missed tail replays from the durable
 *  event store) and then probes the authoritative state — an idle runtime
 *  with no pending interaction settles the turn and resyncs history. */
const TURN_WATCHDOG_TICK_MS = 5_000;

const TURN_WATCHDOG_SILENCE_MS = 20_000;

let turnWatchdogTimer: ReturnType<typeof setInterval> | null = null;

let turnWatchdogReconnected = false;

let lastTurnEventAt = 0;

let turnEventVersion = 0;

let turnWatchdogProbe: object | null = null;

export function noteTurnEvent(): void {
  lastTurnEventAt = Date.now();
  turnEventVersion += 1;
  turnWatchdogReconnected = false;
}

export function disarmTurnWatchdog(): void {
  if (turnWatchdogTimer) {
    clearInterval(turnWatchdogTimer);
    turnWatchdogTimer = null;
  }
  turnWatchdogReconnected = false;
  turnWatchdogProbe = null;
}

/** Arm (or refresh) the live-turn watchdog. Safe to call on every live
 *  event: the timer exists once and reads the current store each tick.
 *  Exported for callers that re-activate a turn outside this listener
 *  (e.g. an answered interaction). */
export function ensureTurnWatchdog(): void {
  noteTurnEvent();
  if (turnWatchdogTimer) return;
  turnWatchdogTimer = globalThis.setInterval(() => { void runTurnWatchdogTick(); }, TURN_WATCHDOG_TICK_MS);
}

async function runTurnWatchdogTick(): Promise<void> {
  const client = listenerBinding.client;
  const current = runtimeStore.getState();
  if (
    !client
    || !current.working
    || !current.activeSessionId
    || !current.cwd
    || current.turnLifecycle === "waiting"
    || current.turnLifecycle === "stopping"
  ) {
    disarmTurnWatchdog();
    return;
  }
  const silentFor = Date.now() - lastTurnEventAt;
  if (silentFor < TURN_WATCHDOG_SILENCE_MS) {
    turnWatchdogReconnected = false;
    return;
  }
  const sessionId = current.activeSessionId;
  const cwd = current.cwd;
  if (!turnWatchdogReconnected) {
    turnWatchdogReconnected = true;
    client.reconnect(sessionId, cwd, "turn_watchdog");
    return;
  }
  // A slow REST request must not accumulate another probe every five seconds.
  if (turnWatchdogProbe) return;
  const probe = {};
  turnWatchdogProbe = probe;
  const eventVersion = turnEventVersion;
  const connectionGeneration = generations.connection;
  const activityGeneration = generations.activity;
  const mutationGeneration = generations.localMutation;
  try {
    const runtimeState = await client.getSessionState(sessionId, cwd);
    const latest = runtimeStore.getState();
    // REST describes the state when requested, not necessarily when received.
    // Replay, a new prompt, an interaction, or a connection replacement can
    // supersede it while awaiting. In particular, do not briefly settle a live
    // turn or disarm its new watchdog on the strength of an old idle response.
    // The event counter also covers metadata events and same-millisecond arrivals.
    if (
      turnWatchdogProbe !== probe
      || client !== listenerBinding.client
      || eventVersion !== turnEventVersion
      || connectionGeneration !== generations.connection
      || activityGeneration !== generations.activity
      || mutationGeneration !== generations.localMutation
      || !latest.working
      || latest.activeSessionId !== sessionId
      || latest.cwd !== cwd
      || latest.turnLifecycle !== current.turnLifecycle
    ) return;
    if (hasActivePendingInteraction(latest.pendingInteraction, latest.pendingQuestionnaire)) {
      runtimeStore.setState({ working: false, turnLifecycle: "waiting", status: "ready" });
      disarmTurnWatchdog();
      return;
    }
    const runtimeWorking = runtimeState.is_streaming
      || runtimeState.is_compacting
      || runtimeState.pending_message_count > 0;
    if (!runtimeWorking) {
      const successful = !turnState.errored;
      bumpConversationGeneration();
      runtimeStore.setState({
        working: false,
        turnLifecycle: successful ? "settled" : "failed",
        status: successful ? "ready" : "error",
        pendingInteraction: null,
        pendingInteractionQueue: [],
        pendingQuestionnaire: null,
      });
      markWorkspaceFilesChanged();
      if (successful) void resyncCompletedHistory(sessionId, cwd);
      disarmTurnWatchdog();
    }
  } catch {
    // A failed probe is retried on the next tick.
  } finally {
    // A superseded request must not clear the next watchdog's in-flight probe.
    if (turnWatchdogProbe === probe) turnWatchdogProbe = null;
  }
}
