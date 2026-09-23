/** Single SSE subscription that drives the store: connection status, turn
 *  lifecycle, interaction prompts and thread folding. */

import type { PiScienceClient, PiScienceEvent, SessionStats } from "../client/pi-science-client";
import { aiTitleAttemptedAt, hasAiTitle, markAiTitleAttempted } from "../client/pi-science-client";
import { appendRuntimeError, isMissingSessionError } from "./errors";
import { markWorkspaceFilesChanged } from "./file-revision";
import { foldEvent, resetTurnBuffer } from "./event-fold";
import { bumpConversationGeneration, bumpPresentationMetadataGeneration, generations, turnState } from "./generations";
import { applyTransportEvent, RECONNECT_REASONS, type ReconnectReason } from "./transport-status";
import { consumeSuppressedConnectionRecovery, reconcileAfterConnectionLoss, reconcileAfterGap, recoverMissingSession, resyncCompletedHistory } from "./recovery";
import { applyAiSessionName } from "./naming";
import { applySessionReplacements } from "./session-replacement";
import { loadSessionsInternal, optimisticSessionIds } from "./sessions";
import { hasActivePendingInteraction } from "./types";
import { useRuntimeStore } from "./store";
import type { PendingInteraction, PendingQuestionnaire } from "./types";

type InteractionKind = NonNullable<PendingInteraction["kind"]>;

const RECONNECT_REASON_SET = new Set<string>(RECONNECT_REASONS);

/** Attribution travels with the transport event; an event emitted before the
 *  reason field existed carries none, so the caller supplies its own. */
function reconnectReason(event: PiScienceEvent, fallback: ReconnectReason): ReconnectReason {
  return typeof event.reason === "string" && RECONNECT_REASON_SET.has(event.reason)
    ? event.reason as ReconnectReason
    : fallback;
}

function interactionKind(value: unknown): InteractionKind | undefined {
  return value === "permission" || value === "confirmation" || value === "question" ? value : undefined;
}

/** The client whose stream is currently folded into the store, and the
 *  unsubscribe handle for that subscription. Re-registering for the same
 *  client is a no-op, so switching sessions never stacks listeners. */
let _listenerClient: PiScienceClient | null = null;
let _listenerUnsubscribe: (() => void) | null = null;

/** Bounded optimistic-session reconnect: a freshly created session may briefly
 *  be invisible to the disk-based existence check (JSONL flushes after the
 *  session event), so the first terminal not-found error retries the attach.
 *  A session that never materializes must not reconnect forever: after the
 *  cap, fall through to the normal missing-session recovery. */
const OPTIMISTIC_RETRY_MAX = 2;
const OPTIMISTIC_RETRY_DELAY_MS = 750;
const optimisticRetries = new Map<string, number>();
let optimisticRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearOptimisticRetry(): void {
  if (optimisticRetryTimer) { clearTimeout(optimisticRetryTimer); optimisticRetryTimer = null; }
}

/** AI title generation is best-effort: one in-flight request per session,
 *  skipped once a title is already marked as AI-generated, silent on failure.
 *  Failed attempts are recorded with a TTL so a broken provider or runtime
 *  does not spawn a fresh Pi process on every idle event. */
const aiTitleInFlight = new Set<string>();
const AI_TITLE_RETRY_MS = 60 * 60 * 1000;

function maybeGenerateAiTitle(sessionId: string, cwd?: string): void {
  const client = _listenerClient;
  if (!client || !cwd || hasAiTitle(cwd, sessionId)) return;
  const attemptedAt = aiTitleAttemptedAt(cwd, sessionId);
  if (attemptedAt && Date.now() - attemptedAt < AI_TITLE_RETRY_MS) return;
  const key = `${cwd}\u0000${sessionId}`;
  if (aiTitleInFlight.has(key)) return;
  aiTitleInFlight.add(key);
  void client
    .generateSessionTitle(sessionId, cwd)
    .then((title) => {
      if (title) applyAiSessionName(cwd, sessionId, title);
      else markAiTitleAttempted(cwd, sessionId);
    })
    .catch(() => {
      markAiTitleAttempted(cwd, sessionId);
    })
    .finally(() => {
      aiTitleInFlight.delete(key);
    });
}

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

function noteTurnEvent(): void {
  lastTurnEventAt = Date.now();
  turnEventVersion += 1;
  turnWatchdogReconnected = false;
}

function disarmTurnWatchdog(): void {
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
  const client = _listenerClient;
  const current = useRuntimeStore.getState();
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
    const latest = useRuntimeStore.getState();
    // REST describes the state when requested, not necessarily when received.
    // Replay, a new prompt, an interaction, or a connection replacement can
    // supersede it while awaiting. In particular, do not briefly settle a live
    // turn or disarm its new watchdog on the strength of an old idle response.
    // The event counter also covers metadata events and same-millisecond arrivals.
    if (
      turnWatchdogProbe !== probe
      || client !== _listenerClient
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
      useRuntimeStore.setState({ working: false, turnLifecycle: "waiting", status: "ready" });
      disarmTurnWatchdog();
      return;
    }
    const runtimeWorking = runtimeState.is_streaming
      || runtimeState.is_compacting
      || runtimeState.pending_message_count > 0;
    if (!runtimeWorking) {
      const successful = !turnState.errored;
      bumpConversationGeneration();
      useRuntimeStore.setState({
        working: false,
        turnLifecycle: successful ? "settled" : "failed",
        status: successful ? "ready" : "error",
        pendingInteraction: null,
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

function questionnaireQuestions(value: unknown): PendingQuestionnaire["questions"] {  if (!Array.isArray(value)) return [];
  return value.flatMap((rawQuestion) => {
    if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) return [];
    const question = rawQuestion as Record<string, unknown>;
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
        if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return [];
        const option = rawOption as Record<string, unknown>;
        const label = typeof option.label === "string" ? option.label : "";
        if (!label) return [];
        return [{
          label,
          description: typeof option.description === "string" ? option.description : "",
          ...(typeof option.preview === "string" && option.preview ? { preview: option.preview } : {}),
        }];
      })
      : [];
    const prompt = typeof question.question === "string" ? question.question : "";
    if (!prompt || options.length === 0) return [];
    return [{
      question: prompt,
      header: typeof question.header === "string" ? question.header : "",
      multiSelect: question.multiSelect === true,
      options,
    }];
  });
}

export function registerEventListener(client: PiScienceClient) {
  if (_listenerClient === client && _listenerUnsubscribe) return;
  disarmTurnWatchdog();
  clearOptimisticRetry();
  optimisticRetries.clear();
  _listenerUnsubscribe?.();
  _listenerClient = client;
  _listenerUnsubscribe = client.onEvent((event) => {
    const state = useRuntimeStore.getState();
    if (event.sessionId && state.activeSessionId && event.sessionId !== state.activeSessionId) {
      return;
    }
    // Transport lifecycle chatter (connection.connecting/closed/ready) does
    // not count as turn activity: the watchdog's reconnect emits one and
    // must not reset its own silence clock.
    if (!event.type.startsWith("connection.")) noteTurnEvent();

    if (event.type === "session.replaced") {
      const replacementSessionId = String(event.replacementSessionId || "");
      if (!replacementSessionId) return;
      const previousActiveId = state.activeSessionId;
      const nextActiveId = applySessionReplacements([{
        cwd: state.cwd,
        oldId: String(event.sessionId || state.activeSessionId || ""),
        newId: replacementSessionId,
      }]);
      // Adopting a replacement re-attaches the stream and clears the thread, so
      // this record cannot leave a hole behind. A record that changed nothing
      // still consumed a position and must reach the fold below.
      if (nextActiveId !== previousActiveId) return;
    }

    if (event.type === "stream.gap") {
      bumpConversationGeneration();
      resetTurnBuffer();
      turnState.errored = false;
      // A gap is a projection repair, not a lost backend: a session the user
      // is already working in stays ready while the rebase runs. Only a
      // session that never reached ready keeps showing the attach phase.
      applyTransportEvent({
        transport: "recovering",
        reason: "stream_gap",
        foreground: "connecting",
        keepReady: true,
        sessionId: state.activeSessionId,
        detail: "server declared a stream gap",
      });
      // Recover the authoritative snapshot from REST (messages + state). We do
      // NOT clear `working` here: if the backend is still mid-turn, Send must
      // stay disabled until the authoritative state read reports idle.
      if (state.activeSessionId) {
        const sessionId = state.activeSessionId;
        const cwd = state.cwd;
        void reconcileAfterGap(sessionId, cwd, { resetTransport: true, reconnectTransport: true });
      }
      return false;
    }

    if (event.type === "connection.connecting" || event.type === "connection.reconnecting") {
      const reconnecting = event.type === "connection.reconnecting";
      // Same-session stream repair is background work. It updates transport
      // diagnostics and must not demote a ready conversation to `connecting`;
      // a foreground attach already set `connecting` before connecting.
      applyTransportEvent({
        transport: reconnecting ? "reconnecting" : "connecting",
        reason: reconnectReason(event, reconnecting ? "transport_error" : "initial_attach"),
        foreground: "connecting",
        keepReady: true,
        sessionId: state.activeSessionId,
        detail: String(event.message ?? ""),
      });
      if (reconnecting && state.activeSessionId) {
        void reconcileAfterConnectionLoss(
          client,
          state.activeSessionId,
          state.cwd,
          generations.connection,
          generations.activity,
        );
      }
      return;
    }
    if (event.type === "connection.open") {
      applyTransportEvent({
        transport: "open",
        reason: reconnectReason(event, "initial_attach"),
        foreground: "ready",
        sessionId: state.activeSessionId,
      });
      return;
    }
    if (event.type === "connection.error") {
      appendRuntimeError(
        new Error(String(event.message || "Conversation stream closed")),
        state.activeSessionId,
        state.cwd,
      );
      // A transport error is not proof that the session is unusable. The
      // authoritative recovery below decides: it keeps the foreground ready
      // when it recovers and promotes to `error` only when it gives up.
      applyTransportEvent({
        transport: "error",
        reason: reconnectReason(event, "transport_error"),
        sessionId: state.activeSessionId,
        detail: String(event.message ?? ""),
      });
      if (state.activeSessionId) {
        void reconcileAfterConnectionLoss(
          client,
          state.activeSessionId,
          state.cwd,
          generations.connection,
          generations.activity,
        );
      }
      return;
    }
    if (event.type === "connection.closed") {
      applyTransportEvent({
        transport: "closed",
        reason: reconnectReason(event, "manual"),
        foreground: "offline",
        sessionId: state.activeSessionId,
      });
      if (state.activeSessionId && !consumeSuppressedConnectionRecovery(client, state.activeSessionId, state.cwd)) {
        void reconcileAfterConnectionLoss(
          client,
          state.activeSessionId,
          state.cwd,
          generations.connection,
          generations.activity,
        );
      }
      return;
    }

    if (
      event.type === "error"
      && event.terminal === true
      && isMissingSessionError(event.message)
    ) {
      const missingSessionId = String(event.sessionId || state.activeSessionId || "");
      // A just-created session can briefly be invisible to the disk-based
      // existence check: the Pi process writes its JSONL only after emitting
      // the session event, so the first SSE connect may see a terminal
      // "session not found" while the record is still being flushed. For an
      // optimistic (locally created, not yet listed from disk) session, retry
      // the attach instead of treating the turn as dead — recovering would
      // blank the conversation the user just started.
      if (missingSessionId && optimisticSessionIds.has(missingSessionId)) {
        const attempts = optimisticRetries.get(missingSessionId) ?? 0;
        if (attempts < OPTIMISTIC_RETRY_MAX) {
          optimisticRetries.set(missingSessionId, attempts + 1);
          useRuntimeStore.setState({ status: "connecting" });
          clearOptimisticRetry();
          optimisticRetryTimer = setTimeout(() => {
            optimisticRetryTimer = null;
            const latest = useRuntimeStore.getState();
            if (latest.activeSessionId === missingSessionId && latest.cwd === state.cwd) {
              client.connect(missingSessionId, state.cwd);
            }
          }, OPTIMISTIC_RETRY_DELAY_MS);
          return;
        }
        // The session never materialized on disk within the retry window: stop
        // treating it as optimistic so the normal missing-session recovery runs
        // (it clears the active session instead of reconnecting forever).
        optimisticSessionIds.delete(missingSessionId);
        optimisticRetries.delete(missingSessionId);
      }
      recoverMissingSession(missingSessionId, state.cwd, client);
      return;
    }

    if (event.type === "questionnaire.asked") {
      const questions = questionnaireQuestions(event.questions);
      // An invalid payload cannot build a card, but it consumed a stream
      // position just the same: fold it instead of dropping it.
      if (questions.length > 0) {
        bumpConversationGeneration();
        useRuntimeStore.setState({
          working: true,
          turnLifecycle: "waiting",
          status: "ready",
          pendingQuestionnaire: {
            toolCallId: String(event.toolCallId || ""),
            questions,
          },
        });
      }
    }

    if (event.type === "questionnaire.finished") {
      bumpConversationGeneration();
      const current = useRuntimeStore.getState();
      const toolCallId = String(event.toolCallId || "");
      const questionnaireMatches = current.pendingQuestionnaire?.toolCallId === toolCallId;
      const interactionMatches = current.pendingInteraction?.questionnaire === true
        && current.pendingInteraction.toolCallId === toolCallId;
      useRuntimeStore.setState({
        ...(questionnaireMatches ? { pendingQuestionnaire: null } : {}),
        ...(interactionMatches ? { pendingInteraction: null } : {}),
      });
    }

    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};

    if (event.type === "interaction.requested") {
      const interactionId = String(event.interactionId || event.requestId || payload.interactionId || payload.requestId || event.itemId || "");
      // Same rule for a request without an id: no card, but the position is
      // still consumed, so it is folded below rather than dropped.
      if (interactionId) {
        bumpConversationGeneration();
        const method = String(event.method || payload.method || "input") as PendingInteraction["method"];
        const kind = interactionKind(event.kind) ?? interactionKind(payload.kind) ?? (method === "confirm" ? "confirmation" : "question");
        useRuntimeStore.setState({
          working: true,
          turnLifecycle: "waiting",
          status: "ready",
          pendingInteraction: {
            requestId: interactionId,
            kind,
            method: ["confirm", "select", "input", "editor"].includes(method) ? method : "input",
            title: String(event.title || payload.title || "Question"),
            message: String(event.message || payload.message || ""),
            options: Array.isArray(event.options || payload.options) ? (event.options || payload.options) as PendingInteraction["options"] : [],
            placeholder: String(event.placeholder || payload.placeholder || ""),
            prefill: String(event.prefill || payload.prefill || ""),
            operation: String(event.operation || payload.operation || ""),
            scope: String(event.scope || payload.scope || ""),
            effect: String(event.effect || payload.effect || ""),
          },
        });
      }
      // The reducer still records the envelope; the interaction card is a
      // separate state dimension and must not be hidden by process folding.
    } else if (event.type === "interaction.resolved") {
      bumpConversationGeneration();
      const interactionId = String(event.interactionId || event.requestId || payload.interactionId || payload.requestId || event.itemId || "");
      const current = useRuntimeStore.getState();
      if (current.pendingInteraction?.requestId === interactionId) {
        useRuntimeStore.setState({ pendingInteraction: null, turnLifecycle: current.working ? "active" : current.turnLifecycle });
      }
    }

    if (event.type === "permission.asked" || event.type === "question.asked") {
      bumpConversationGeneration();
      const method = (event.method as PendingInteraction["method"]) || (event.type === "permission.asked" ? "confirm" : "input");
      const kind = interactionKind(event.kind)
        ?? (event.type === "permission.asked"
          ? "permission"
          : method === "confirm"
            ? "confirmation"
            : "question");
      useRuntimeStore.setState({
        working: true,
        turnLifecycle: "waiting",
        status: "ready",
        pendingInteraction: {
          requestId: String(event.requestId || ""),
          kind,
          method,
          title: String(event.title || (method === "confirm" ? "Confirmation" : "Question")),
          message: String(event.message || ""),
          options: Array.isArray(event.options) ? event.options as PendingInteraction["options"] : [],
          placeholder: String(event.placeholder || ""),
          prefill: String(event.prefill || ""),
          operation: String(event.operation || ""),
          scope: String(event.scope || ""),
          effect: String(event.effect || ""),
          ...(event.questionnaire === true ? { questionnaire: true, toolCallId: String(event.toolCallId || "") } : {}),
        },
      });
    }

    const eventStatus = String(event.status ?? payload.status ?? "");
    const runStarted = event.type === "agent_start" || event.type === "run.started";
    const activityEvent = event.type === "text.updated"
      || event.type === "thinking.updated"
      || event.type === "item.text.delta"
      || event.type === "item.snapshot"
      || event.type === "item.started"
      || event.type === "item.completed"
      || event.type === "tool.updated"
      || event.type === "plan.updated";
    const knownTerminalRun = typeof event.runId === "string" && state.thread.foldState?.terminalRunIds.includes(event.runId);
    if (runStarted && !knownTerminalRun && state.turnLifecycle !== "stopping") {
      bumpConversationGeneration();
      resetTurnBuffer();
      turnState.errored = false;
      useRuntimeStore.setState({ working: true, turnLifecycle: "active", status: "ready" });
      ensureTurnWatchdog();
    } else if (activityEvent) {
      bumpConversationGeneration();
      if (!blocksLateEvents(state.turnLifecycle) && state.turnLifecycle !== "stopping" && !knownTerminalRun) {
        turnState.errored = false;
        useRuntimeStore.setState({ working: true, turnLifecycle: event.type === "tool.updated" && eventStatus === "waiting-approval" ? "waiting" : "active", status: "ready" });
        if (state.turnLifecycle !== "waiting") ensureTurnWatchdog();
      }
    } else if (event.type === "compaction.updated") {
      bumpConversationGeneration();
      const status = String(event.status || "");
      const failed = status === "error";
      // Compaction ending is not the end of the agent run: generation resumes
      // afterward. Only a run terminal event may settle its activity row.
      useRuntimeStore.setState({ working: !failed, turnLifecycle: failed ? "failed" : "active", status: failed ? "error" : "ready" });
      if (failed) disarmTurnWatchdog();
      else ensureTurnWatchdog();
    } else if (event.type === "turn.artifacts") {
      bumpPresentationMetadataGeneration();
      // No extra tree refresh here: the server publishes this event from the
      // agent_settled observer, and that settled event already bumped the
      // file revision above. Marking again would double-refresh every turn.
    } else if (event.type === "agent_settled" || event.type === "session.idle" || event.type === "run.completed" || event.type === "run.cancelled") {
      bumpConversationGeneration();
      if (!blocksLateEvents(state.turnLifecycle)) {
        const successful = !turnState.errored;
        const cancelled = event.type === "run.cancelled" || event.cancelled === true;
        useRuntimeStore.setState({
          working: false,
          turnLifecycle: cancelled ? "aborted" : successful ? "settled" : "failed",
          status: successful || cancelled ? "ready" : "error",
          pendingInteraction: null,
          pendingQuestionnaire: null,
        });
        disarmTurnWatchdog();
        markWorkspaceFilesChanged();
        if (successful && state.activeSessionId && event.handledWithoutTurn !== true) {
          void resyncCompletedHistory(state.activeSessionId, state.cwd);
          maybeGenerateAiTitle(state.activeSessionId, state.cwd);
        }
      }
      void loadSessionsInternal();
    } else if (event.type === "session.stats") {
      bumpPresentationMetadataGeneration();
      const stats = event.stats as SessionStats | undefined;
      // Only the active session may write the stats line. Events without a
      // session id or for a session the user already left (late arrival) must
      // not overwrite the current session's numbers.
      if (stats && typeof stats === "object" && state.activeSessionId && event.sessionId === state.activeSessionId) {
        useRuntimeStore.setState({ sessionStats: stats });
      }
    } else if (event.type === "error" || event.type === "run.failed") {
      bumpConversationGeneration();
      if (event.recoverable === true) {
        if (!blocksLateEvents(state.turnLifecycle)) useRuntimeStore.setState({ turnLifecycle: "recovering", status: "connecting" });
      } else if (!blocksLateEvents(state.turnLifecycle)) {
        turnState.errored = true;
        useRuntimeStore.setState({ working: false, turnLifecycle: "failed", status: "error", pendingInteraction: null, pendingQuestionnaire: null });
        disarmTurnWatchdog();
      }
    }

    // Every record that reaches this point has consumed a stream position, and
    // the fold's sequence waterline is what tells a lost event apart from one
    // that simply produced no conversation block. So an interaction record —
    // questionnaire, permission, question, malformed interaction — is folded
    // even when its UI state could not be built. Only records carrying no
    // position at all (`connection.*`, `stream.gap`) and the missing-session
    // retry above — which re-attaches a stream whose records are not durable
    // yet — may skip this.
    const current = useRuntimeStore.getState();
    const newThread = foldEvent(current.thread, event);
    if (newThread.blocks !== current.thread.blocks || newThread.foldState !== current.thread.foldState) {
      useRuntimeStore.setState({ thread: newThread });
    }
    if (newThread.foldState?.reconciliationRequired && event.type !== "stream.gap") {
      const recoveryState = useRuntimeStore.getState();
      const recoverySessionId = recoveryState.activeSessionId ?? (event.sessionId ? String(event.sessionId) : null);
      if (recoverySessionId) {
        // A sequence/epoch discontinuity inside a live session is the same
        // class of repair as a server gap: rebase the projection without
        // pretending the backend went away.
        applyTransportEvent({
          transport: "recovering",
          reason: "stream_gap",
          foreground: "connecting",
          keepReady: true,
          sessionId: recoverySessionId,
          // The event identity is what makes a recurrence attributable: a
          // sequence hole, a stale delta and an epoch change all land here.
          detail: `projection discontinuity (${event.type} seq=${String(event.seq ?? "-")} part=${String(event.partId ?? "-")} rev=${String(event.revision ?? "-")} base=${String(event.baseRevision ?? "-")})`,
        });
        void reconcileAfterGap(recoverySessionId, recoveryState.cwd, { resetTransport: true, reconnectTransport: true });
      }
      // Do not advance the applied SSE cursor while the authoritative rebase
      // is in flight. The single-flight recovery owns the next reconnect.
      return false;
    }
    if (
      event.schemaVersion === 2
      && newThread.foldState?.pendingEvents.some((pending) => pending.eventId === event.eventId)
    ) return false;
    return true;
  });
}

function blocksLateEvents(lifecycle: string): boolean { return lifecycle === "aborted" || lifecycle === "failed"; }
