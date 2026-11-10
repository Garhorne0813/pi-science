/** Apply activity effects against the snapshot captured before this event was dispatched. */
import type { PiScienceEvent, SessionStats } from "../../client/pi-science-client";
import { markWorkspaceFilesChanged } from "../file-revision";
import { resetTurnBuffer } from "../folding/state";
import { bumpConversationGeneration, bumpPresentationMetadataGeneration, generations, turnState } from "../generations";
import { resyncCompletedHistory } from "../recovery/settled-history";
import { loadSessionsInternal } from "../sessions";
import { runtimeStore } from "../store-access";
import type { ThreadBlock } from "../../../types/thread";
import { createFoldState } from "../folding/state";
import type { RuntimeState } from "../types";
import { disarmTurnWatchdog, ensureTurnWatchdog } from "./watchdog";
import { maybeGenerateAiTitle } from "./titles";

function blocksLateEvents(lifecycle: string): boolean { return lifecycle === "aborted" || lifecycle === "failed"; }

export function applyLifecycleEvent(event: PiScienceEvent, state: RuntimeState): void {
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown> : {};
  const eventStatus = String(event.status ?? payload.status ?? "");
  const runStarted = event.type === "operation.started";
  const activityEvent = event.type === "message.delta"
    || event.type === "message.reasoning.delta"
    || event.type === "message.started"
    || event.type === "message.snapshot"
    || event.type === "tool.started"
    || event.type === "tool.completed"
    || event.type === "tool.updated"
    || event.type === "plan.updated";
  const knownTerminalRun = typeof event.runId === "string" && state.thread.foldState?.terminalRunIds.includes(event.runId);
  if (runStarted && !knownTerminalRun && state.turnLifecycle !== "stopping") {
    bumpConversationGeneration();
    resetTurnBuffer();
    turnState.errored = false;
    runtimeStore.setState({ working: true, turnLifecycle: "active", status: "ready" });
    ensureTurnWatchdog();
  } else if (activityEvent) {
    bumpConversationGeneration();
    if (!blocksLateEvents(state.turnLifecycle) && state.turnLifecycle !== "stopping" && !knownTerminalRun) {
      turnState.errored = false;
      runtimeStore.setState({ working: true, turnLifecycle: state.pendingInteraction || state.pendingQuestionnaire || event.type === "tool.updated" && eventStatus === "waiting-approval" ? "waiting" : "active", status: "ready" });
      if (state.turnLifecycle !== "waiting") ensureTurnWatchdog();
    }
  } else if (event.type === "compaction.progress" || event.type === "compaction.started" || event.type === "compaction.completed" || event.type === "compaction.failed") {
    bumpConversationGeneration();
    const status = String(event.status || "");
    const failed = status === "error";
    // Compaction ending is not the end of the agent run: generation resumes
    // afterward. Only a run terminal event may settle its activity row.
    runtimeStore.setState({ working: !failed, turnLifecycle: failed ? "failed" : "active", status: failed ? "error" : "ready" });
    if (failed) disarmTurnWatchdog();
    else ensureTurnWatchdog();
  } else if (event.type === "turn.artifacts") {
    bumpPresentationMetadataGeneration();
    // No extra tree refresh here: the server publishes this event from the
    // operation.settled observer, and that settled event already bumped the
    // file revision above. Marking again would double-refresh every turn.
  } else if (event.type === "operation.settled") {
    bumpConversationGeneration();
    if (!blocksLateEvents(state.turnLifecycle)) {
      const successful = !turnState.errored && event.status !== "failed";
      const cancelled = event.status === "aborted";
      runtimeStore.setState({
        working: false,
        turnLifecycle: cancelled ? "aborted" : successful ? "settled" : "failed",
        status: successful || cancelled ? "ready" : "error",
        pendingInteraction: null,
        pendingInteractionQueue: [],
        pendingQuestionnaire: null,
      });
      disarmTurnWatchdog();
      markWorkspaceFilesChanged();
      if (successful && state.activeSessionId && event.handledWithoutTurn !== true) {
        void resyncCompletedHistory(state.activeSessionId, state.cwd);
        if (event.status === "completed") maybeGenerateAiTitle(state.activeSessionId, state.cwd);
      }
    }
    void loadSessionsInternal();
  } else if (event.type === "runtime.paused") {
    runtimeStore.setState({ working: false, turnLifecycle: "failed", status: "error", pendingInteraction: null, pendingInteractionQueue: [], pendingQuestionnaire: null });
    disarmTurnWatchdog();
  } else if (event.type === "session.stats") {
    bumpPresentationMetadataGeneration();
    const stats = event.stats as SessionStats | undefined;
    // Only the active session may write the stats line. Events without a
    // session id or for a session the user already left (late arrival) must
    // not overwrite the current session's numbers.
    if (stats && typeof stats === "object" && state.activeSessionId && event.sessionId === state.activeSessionId) {
      runtimeStore.setState({ sessionStats: stats });
    }
  } else if (event.type === "error") {
    bumpConversationGeneration();
    if (event.recoverable === true) {
      if (!blocksLateEvents(state.turnLifecycle)) runtimeStore.setState({ turnLifecycle: "recovering", status: "connecting" });
    } else if (!blocksLateEvents(state.turnLifecycle)) {
      turnState.errored = true;
      runtimeStore.setState({ working: false, turnLifecycle: "failed", status: "error", pendingInteraction: null, pendingInteractionQueue: [], pendingQuestionnaire: null });
      disarmTurnWatchdog();
      // Only a terminal error stands in for operation.settled: recovery is
      // exhausted, so no settle event will ever follow and the part of the
      // turn the worker already persisted would stay off screen. Keep the turn
      // failed, but re-read once through the guarded path. Non-terminal
      // failures (model error, runtime error, idle empty reply, settings
      // reload) keep the worker alive and their settled event already runs
      // this re-read on success; re-reading here would replace the thread —
      // dropping this error row and any in-flight partial — while the turn is
      // still going.
      if (event.terminal === true && state.activeSessionId) {
        const sessionId = state.activeSessionId;
        const { cwd } = state;
        const conversationGeneration = generations.conversation;
        const line = {
          text: typeof event.message === "string" && event.message ? event.message : "Unknown error",
          turnId: typeof event.turnId === "string" ? event.turnId : state.thread.foldState?.activeTurnId,
          runId: typeof event.runId === "string" ? event.runId : state.thread.foldState?.activeRunId,
        };
        void resyncCompletedHistory(sessionId, cwd)
          .then(() => restoreErrorRow(sessionId, cwd, conversationGeneration, line));
      }
    }
  }

}

/** A history re-read replaces the thread wholesale, so the error row the fold
 *  produced for this event would vanish and the user would see a failed turn
 *  with an answer but no reason. Put it back once the re-read settles, unless
 *  the tape has moved on: a newer conversation event owns the thread by then,
 *  and the row belongs to the turn this error closed. */
function restoreErrorRow(
  sessionId: string,
  cwd: string,
  conversationGeneration: number,
  line: { text: string; turnId?: string; runId?: string },
): void {
  const state = runtimeStore.getState();
  if (state.activeSessionId !== sessionId || state.cwd !== cwd) return;
  if (conversationGeneration !== generations.conversation) return;
  const sameRow = (block: ThreadBlock) => block.kind === "status-line" && block.level === "error" && (
    line.turnId !== undefined
      ? block.turnId === line.turnId
      : line.runId !== undefined
        ? block.runId === line.runId
        : block.text === line.text
  );
  if (state.thread.blocks.some(sameRow)) return;
  const foldState = state.thread.foldState;
  // The re-read drops the fold state, so its counter cannot be trusted to
  // resume: take the serial from the ids that survived. A row still carrying
  // the same id would make the React key and the block index ambiguous.
  const serial = state.thread.blocks.reduce((max, block) => {
    const match = /^error-(\d+)$/.exec(block.id);
    return match ? Math.max(max, Number(match[1]) + 1) : max;
  }, foldState?.errorSerial ?? 0);
  const id = `error-${serial}`;
  const block: ThreadBlock = {
    kind: "status-line",
    id,
    turnId: line.turnId,
    runId: line.runId,
    text: line.text,
    level: "error",
  };
  const blocks = [...state.thread.blocks, block];
  runtimeStore.setState({
    thread: {
      ...state.thread,
      blocks,
      index: { ...state.thread.index, [id]: blocks.length - 1 },
      foldState: { ...(foldState ?? createFoldState()), errorSerial: serial + 1 },
    },
  });
}
