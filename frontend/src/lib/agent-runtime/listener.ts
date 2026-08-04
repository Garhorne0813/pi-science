/** Single SSE subscription that drives the store: connection status, turn
 *  lifecycle, interaction prompts and thread folding. */

import type { PiScienceClient } from "../client/pi-science-client";
import { workspaceFiles } from "../workspace";
import { appendRuntimeError, isMissingSessionError } from "./errors";
import { foldEvent, resetTurnBuffer } from "./event-fold";
import { generations, turnState } from "./generations";
import { reconcileAfterGap, reconcileWorkingState, recoverMissingSession, resyncCompletedHistory } from "./recovery";
import { applySessionReplacements } from "./session-replacement";
import { loadSessionsInternal, optimisticSessionIds } from "./sessions";
import { useRuntimeStore } from "./store";
import type { PendingInteraction, PendingQuestionnaire } from "./types";

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

function questionnaireQuestions(value: unknown): PendingQuestionnaire["questions"] {
  if (!Array.isArray(value)) return [];
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
  clearOptimisticRetry();
  optimisticRetries.clear();
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
      if (questions.length === 0) return;
      ++generations.activity;
      useRuntimeStore.setState({
        working: true,
        status: "ready",
        pendingQuestionnaire: {
          toolCallId: String(event.toolCallId || ""),
          questions,
        },
      });
      return;
    }

    if (event.type === "questionnaire.finished") {
      const current = useRuntimeStore.getState();
      const toolCallId = String(event.toolCallId || "");
      const questionnaireMatches = current.pendingQuestionnaire?.toolCallId === toolCallId;
      const interactionMatches = current.pendingInteraction?.questionnaire === true
        && current.pendingInteraction.toolCallId === toolCallId;
      useRuntimeStore.setState({
        ...(questionnaireMatches ? { pendingQuestionnaire: null } : {}),
        ...(interactionMatches ? { pendingInteraction: null } : {}),
      });
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
          ...(event.questionnaire === true ? { questionnaire: true, toolCallId: String(event.toolCallId || "") } : {}),
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
        pendingQuestionnaire: null,
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
        useRuntimeStore.setState({ working: false, status: "error", pendingInteraction: null, pendingQuestionnaire: null });
      }
    }

    const current = useRuntimeStore.getState();
    const newThread = foldEvent(current.thread, event);
    if (newThread.blocks !== current.thread.blocks) {
      useRuntimeStore.setState({ thread: newThread });
    }
  });
}
