/** Apply activity effects against the snapshot captured before this event was dispatched. */
import type { PiScienceEvent, SessionStats } from "../../client/pi-science-client";
import { markWorkspaceFilesChanged } from "../file-revision";
import { resetTurnBuffer } from "../folding/state";
import { bumpConversationGeneration, bumpPresentationMetadataGeneration, turnState } from "../generations";
import { resyncCompletedHistory } from "../recovery/settled-history";
import { loadSessionsInternal } from "../sessions";
import { runtimeStore } from "../store-access";
import type { RuntimeState } from "../types";
import { disarmTurnWatchdog, ensureTurnWatchdog } from "./watchdog";
import { maybeRequestScienceReview } from "./science-review";
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
        if (event.status === "completed") maybeRequestScienceReview(state.activeSessionId, state.cwd);
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
    }
  }

}
