/** Prompt delivery and abort commands, using the shared store action handles. */
import { v4 as uuidv4 } from "uuid";
import type { ThreadBlock } from "../../../types/thread";
import { getClient, type PromptRequestStatus } from "../../client/pi-science-client";
import { promptContentDigest, removeLocalPromptRequest, saveLocalPromptRequest, updateLocalPromptRequest } from "../../client/prompt-request-cache";
import { appendRuntimeError, isMissingSessionError } from "../errors";
import { resetTurnBuffer } from "../folding/state";
import { generations, turnState } from "../generations";
import { registerEventListener } from "../listening/subscription";
import { applyPromptSessionName } from "../naming";
import { recoverMissingSession } from "../recovery/missing-session";
import { reconcilePromptAfterLateStream } from "../recovery/prompt-monitor";
import type { RuntimeState } from "../types";
import type { GetState, SetState } from "./types";
import { monitorPromptRequest, updateOptimisticStatus } from "./prompt-delivery";

export function createPromptActions(set: SetState, get: GetState): Pick<RuntimeState, "sendPrompt" | "abort"> {

  return {
    sendPrompt: async (message: string, requestedClientMessageId?: string): Promise<string | null> => {
      if (!message.trim()) return null;
      const initialState = get();
      if (initialState.working || initialState.pendingInteraction || initialState.pendingQuestionnaire) {
        throw new Error("The current conversation is still running");
      }
      let { activeSessionId, cwd } = initialState;
      const contentDigest = promptContentDigest(message);
      // A retry identity is meaningful only while the original session is
      // active; a new-session send always receives a fresh scoped ID.
      let clientMessageId = activeSessionId ? requestedClientMessageId : undefined;
      let recoveredStatus: PromptRequestStatus | null = null;
      // A normal composer submission always means a new user send, even when
      // its text matches an older pending/rejected send. Only an explicit
      // retry action supplies the prior ID.
      if (!clientMessageId) clientMessageId = uuidv4();
      else if (activeSessionId) {
        try {
          recoveredStatus = await getClient().getPromptRequestStatus(activeSessionId, clientMessageId, cwd);
          if (recoveredStatus.status === "persisted") {
            updateOptimisticStatus(get, set, recoveredStatus);
            return activeSessionId;
          }
        } catch (error) {
          if ((error as Error & { status?: number }).status === 404) removeLocalPromptRequest(clientMessageId);
          // Reusing the same ID is safe: the server ledger either recognizes
          // it and returns its state without dispatching again, or has no
          // record and can accept this first attempt.
        }
      }
      const requestId = clientMessageId;
      const alreadyPending = recoveredStatus !== null
        && ["pending", "accepted", "indeterminate"].includes(recoveredStatus.status);

      const threadBeforeSend = get().thread;
      const priorOptimistic = threadBeforeSend.blocks.find((block) => block.kind === "user" && block.client_message_id === requestId);
      const userBlock: ThreadBlock = priorOptimistic ?? {
        kind: "user",
        id: `user-${requestId}`,
        client_message_id: requestId,
        deliveryStatus: alreadyPending && recoveredStatus?.status === "indeterminate" ? "indeterminate" : "pending",
        text: message,
        ...(!activeSessionId ? { optimisticFirstInSession: true } : {}),
        timestamp: new Date().toISOString(),
      };
      if (!priorOptimistic) {
        const blocks = [...threadBeforeSend.blocks, userBlock];
        set({ thread: { blocks, index: { ...threadBeforeSend.index, [userBlock.id]: blocks.length - 1 }, loaded: true } });
      }
      saveLocalPromptRequest({
        cwd,
        sessionId: activeSessionId ?? "",
        clientMessageId: requestId,
        contentDigest,
        status: recoveredStatus?.status ?? "pending",
      });

      if (alreadyPending && activeSessionId) {
        updateOptimisticStatus(get, set, recoveredStatus!);
        return activeSessionId;
      }

      const thread = get().thread;
      const blocks = [...thread.blocks];
      const blockPosition = blocks.findIndex((block) => block.id === userBlock.id);
      if (priorOptimistic && priorOptimistic.kind === "user") {
        blocks[blockPosition] = { ...priorOptimistic, deliveryStatus: "pending" };
      }
      const index: Record<string, number> = {};
      blocks.forEach((block, position) => { index[block.id] = position; });
      set({ thread: { blocks, index, loaded: true }, working: true, turnLifecycle: "active", promptDeliveryNotice: null });
      if (!activeSessionId) {
        try {
          activeSessionId = await get().createNewSession();
          updateLocalPromptRequest(requestId, { sessionId: activeSessionId });
        } catch (error) {
          const current = get();
          // The failure belongs to the conversation that sent the prompt. Once the user has
          // opened another one, this late result must not mark it failed.
          if (current.cwd === cwd && current.activeSessionId === activeSessionId) set({ working: false, turnLifecycle: "failed" });
          throw error;
        }
      }
      const client = getClient();
      registerEventListener(client);
      if (!client.isConnectedTo(activeSessionId, cwd)) {
        set({ activeSessionId, client, status: "connecting" });
        client.connect(activeSessionId, cwd);
      }
      const activityGeneration = ++generations.activity;
      ++generations.localMutation;
      resetTurnBuffer();
      turnState.errored = false;
      set({ client, working: true, turnLifecycle: "active" });

      applyPromptSessionName(cwd, activeSessionId, message);
      // Baseline for the late-stream monitor: any assistant message persisted
      // after this instant belongs to the turn being sent. Captured before the
      // HTTP acknowledgement so a fast reply can never be attributed to a
      // previous turn (nor a slow monitor to the wrong prompt).
      const promptTimestamp = Date.now();
      try {
        const delivery = await client.sendPrompt(activeSessionId, message, requestId, cwd);
        updateOptimisticStatus(get, set, delivery);
        if (delivery.status !== "persisted" && delivery.status !== "rejected" && delivery.status !== "indeterminate") {
          void monitorPromptRequest(client, cwd, activeSessionId, requestId, get, set);
        }
        // Monitor every prompt, including those sent through an EventSource
        // that currently reports OPEN. Old-session sockets can be half-open:
        // the backend accepts and persists the turn while no live event reaches
        // the browser. REST reconciliation and a cursor-preserving reconnect
        // make that failure self-healing.
        const monitorGeneration = ++generations.promptMonitor;
        void reconcilePromptAfterLateStream(
          client,
          activeSessionId,
          cwd,
          monitorGeneration,
          promptTimestamp,
          undefined,
          activityGeneration,
        );
        return activeSessionId;
      } catch (error) {
        const metadata = error as Error & { code?: string; status?: number; deliveryState?: PromptRequestStatus["status"] };
        const failedDelivery: PromptRequestStatus = {
          status: metadata.deliveryState
            ?? (metadata.code === "timeout" || metadata.status === undefined || metadata.status >= 500 ? "indeterminate" : "rejected"),
          client_message_id: requestId,
          ...(metadata.code ? { error_code: metadata.code } : {}),
        };
        updateOptimisticStatus(get, set, failedDelivery);
        const current = get();
        if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
          // A stale URL/session can fail before the SSE terminal event arrives.
          // Clear it here as well so the prompt error cannot leave the UI bound
          // to an ID that will only produce more "session not found" events.
          if (isMissingSessionError(error)) {
            recoverMissingSession(activeSessionId, cwd, client);
            throw error;
          }
          // The HTTP acknowledgement can time out after Pi already accepted the
          // prompt. Live events or authoritative streaming state win over that
          // ambiguous transport failure, preventing a false reset to Send.
          if (activityGeneration !== generations.activity && current.working) return null;
          try {
            const runtimeState = await client.getSessionState(activeSessionId, cwd);
            const stillCurrent = get();
            if (
              stillCurrent.activeSessionId === activeSessionId
              && stillCurrent.cwd === cwd
              && (
                runtimeState.is_streaming
                || runtimeState.is_compacting
                || runtimeState.pending_message_count > 0
              )
            ) {
              set({ working: true, status: "connecting" });
              return null;
            }
          } catch {
            // Fall through to the original request error.
          }
          appendRuntimeError(error, activeSessionId, cwd);
          const ambiguousTransportFailure = metadata.code === "timeout"
            || (!metadata.code && (metadata.status === undefined || metadata.status >= 500));
          set({
            // Pi keeps its busy guard after an ambiguous prompt acknowledgement
            // until the user aborts. Keep Stop visible so the UI cannot submit a
            // second prompt against that still-running/unknown turn.
            working: ambiguousTransportFailure,
            turnLifecycle: ambiguousTransportFailure ? "active" : "failed",
            status: "error",
          });
        }
        throw error;
      }
    },
    abort: async () => {
      const { activeSessionId, cwd, turnLifecycle } = get();
      if (!activeSessionId) return;
      ++generations.activity;
      ++generations.localMutation;
      ++generations.promptMonitor;
      // Keep the run visibly in-flight until the server acknowledges the
      // stop. This prevents a second prompt from racing an unconfirmed abort.
      set({ working: true, turnLifecycle: "stopping", status: "ready" });
      try {
        await getClient().abort(activeSessionId, cwd);
        const current = get();
        if (current.activeSessionId === activeSessionId && current.cwd === cwd && current.turnLifecycle === "stopping") {
          set({ working: false, turnLifecycle: "aborted", status: "ready", pendingInteraction: null, pendingInteractionQueue: [], pendingQuestionnaire: null });
        }
      } catch (error) {
        const current = get();
        if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
          appendRuntimeError(error, activeSessionId, cwd);
          const code = error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
          if (code === "runtime_evicted") {
            set({ working: false, turnLifecycle: "aborted", status: "ready", pendingInteraction: null, pendingInteractionQueue: [], pendingQuestionnaire: null });
            return;
          }
          try {
            const runtimeState = await getClient().getSessionState(activeSessionId, cwd);
            const stillCurrent = get();
            if (stillCurrent.activeSessionId === activeSessionId && stillCurrent.cwd === cwd) {
              const busy = runtimeState.is_streaming
                || runtimeState.is_compacting
                || runtimeState.pending_message_count > 0;
              set({
                working: busy,
                turnLifecycle: busy ? "active" : "aborted",
                status: "error",
                ...(busy ? {} : { pendingInteraction: null, pendingInteractionQueue: [], pendingQuestionnaire: null }),
              });
            }
          } catch {
            const stillCurrent = get();
            if (stillCurrent.activeSessionId === activeSessionId && stillCurrent.cwd === cwd) {
              set({ working: true, turnLifecycle: turnLifecycle === "settled" ? "active" : turnLifecycle, status: "error" });
            }
          }
        }
        throw error;
      }
    },
  };
}
