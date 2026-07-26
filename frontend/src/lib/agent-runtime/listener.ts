/** Single SSE subscription that drives the store: connection status, turn
 *  lifecycle, interaction prompts and thread folding. */

import type { PiScienceClient } from "../pi-science-client";
import { workspaceFiles } from "../workspace-files";
import { appendRuntimeError, isMissingSessionError } from "./errors";
import { foldEvent, resetTurnBuffer } from "./event-fold";
import { generations, turnState } from "./generations";
import { reconcileAfterGap, reconcileWorkingState, recoverMissingSession, resyncCompletedHistory } from "./recovery";
import { applySessionReplacements } from "./session-replacement";
import { loadSessionsInternal } from "./sessions";
import { useRuntimeStore } from "./store";
import type { PendingInteraction } from "./types";

/** The client whose stream is currently folded into the store, and the
 *  unsubscribe handle for that subscription. Re-registering for the same
 *  client is a no-op, so switching sessions never stacks listeners. */
let _listenerClient: PiScienceClient | null = null;
let _listenerUnsubscribe: (() => void) | null = null;

export function registerEventListener(client: PiScienceClient) {
  if (_listenerClient === client && _listenerUnsubscribe) return;
  _listenerUnsubscribe?.();
  _listenerClient = client;
  _listenerUnsubscribe = client.onEvent((event) => {
    const state = useRuntimeStore.getState();
    if (event.sessionId && state.activeSessionId && event.sessionId !== state.activeSessionId) {
      return;
    }

    if (event.type === "session.replaced") {
      const replacementSessionId = String(event.replacementSessionId || "");
      if (!replacementSessionId) return;
      applySessionReplacements([{
        cwd: state.cwd,
        oldId: String(event.sessionId || state.activeSessionId || ""),
        newId: replacementSessionId,
      }]);
      return;
    }

    if (event.type === "stream.gap") {
      ++generations.activity;
      resetTurnBuffer();
      turnState.errored = false;
      useRuntimeStore.setState({
        status: "connecting",
      });
      // Recover the authoritative snapshot from REST (messages + state). We do
      // NOT clear `working` here: if the backend is still mid-turn, Send must
      // stay disabled until the authoritative state read reports idle.
      if (state.activeSessionId) {
        const sessionId = state.activeSessionId;
        const cwd = state.cwd;
        void reconcileAfterGap(sessionId, cwd);
      }
      return;
    }

    if (event.type === "connection.connecting" || event.type === "connection.reconnecting") {
      useRuntimeStore.setState({ status: "connecting" });
      return;
    }
    if (event.type === "connection.open") {
      useRuntimeStore.setState({ status: "ready" });
      return;
    }
    if (event.type === "connection.error") {
      useRuntimeStore.setState({ status: "error" });
      appendRuntimeError(
        new Error(String(event.message || "Conversation stream closed")),
        state.activeSessionId,
        state.cwd,
      );
      if (state.activeSessionId) {
        void reconcileWorkingState(
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
      if (state.status !== "offline") useRuntimeStore.setState({ status: "offline" });
      return;
    }

    if (
      event.type === "error"
      && event.terminal === true
      && isMissingSessionError(event.message)
    ) {
      recoverMissingSession(String(event.sessionId || state.activeSessionId || ""), state.cwd, client);
      return;
    }

    if (event.type === "permission.asked" || event.type === "question.asked") {
      ++generations.activity;
      const method = event.type === "permission.asked"
        ? "confirm"
        : (event.method as PendingInteraction["method"]) || "input";
      useRuntimeStore.setState({
        working: true,
        status: "ready",
        pendingInteraction: {
          requestId: String(event.requestId || ""),
          method,
          title: String(event.title || (method === "confirm" ? "Confirmation" : "Question")),
          message: String(event.message || ""),
          options: Array.isArray(event.options) ? event.options as PendingInteraction["options"] : [],
          placeholder: String(event.placeholder || ""),
          prefill: String(event.prefill || ""),
        },
      });
      return;
    }

    if (event.type === "agent_start") {
      ++generations.activity;
      resetTurnBuffer();
      turnState.errored = false;
      useRuntimeStore.setState({ working: true, status: "ready" });
    } else if (event.type === "text.updated" || event.type === "tool.updated") {
      ++generations.activity;
      turnState.errored = false;
      useRuntimeStore.setState({ working: true, status: "ready" });
    } else if (event.type === "compaction.updated") {
      ++generations.activity;
      const status = String(event.status || "");
      const failed = status === "error";
      const finished = status === "end" || failed;
      useRuntimeStore.setState({ working: !finished, status: failed ? "error" : "ready" });
    } else if (event.type === "agent_settled" || event.type === "session.idle") {
      ++generations.activity;
      const successful = !turnState.errored;
      workspaceFiles.invalidate();
      useRuntimeStore.setState({
        working: false,
        status: successful ? "ready" : "error",
        pendingInteraction: null,
        fileRevision: (state.fileRevision ?? 0) + 1,
      });
      if (successful && state.activeSessionId && event.handledWithoutTurn !== true) {
        void resyncCompletedHistory(state.activeSessionId, state.cwd);
      }
      void loadSessionsInternal();
    } else if (event.type === "error") {
      ++generations.activity;
      if (event.recoverable === true) {
        useRuntimeStore.setState({ status: "connecting" });
      } else {
        turnState.errored = true;
        useRuntimeStore.setState({ working: false, status: "error", pendingInteraction: null });
      }
    }

    const current = useRuntimeStore.getState();
    const newThread = foldEvent(current.thread, event);
    if (newThread.blocks !== current.thread.blocks) {
      useRuntimeStore.setState({ thread: newThread });
    }
  });
}
