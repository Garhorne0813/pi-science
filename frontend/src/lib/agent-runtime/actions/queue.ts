/** Steer delivery and the durable follow-up queue. Both are session-scoped
 *  requests: a late reply is dropped when the user has moved elsewhere. */
import { v4 as uuidv4 } from "uuid";
import type { QueuedMessage } from "@pi-science/contracts";
import { getClient } from "../../client/pi-science-client";
import type { RuntimeState } from "../types";
import type { GetState, SetState } from "./types";

interface QueueSnapshot {
  entries: QueuedMessage[];
  paused: boolean;
  paused_reason?: string;
}

export function createQueueActions(set: SetState, get: GetState): Pick<RuntimeState, "sendSteer" | "enqueueMessage" | "loadQueue" | "editQueuedMessage" | "cancelQueuedMessage" | "retryQueuedMessage" | "resumeQueue" | "dispatchQueuedMessage"> {
  const apply = (cwd: string, sessionId: string, snapshot: QueueSnapshot) => {
    const current = get();
    if (current.cwd !== cwd || current.activeSessionId !== sessionId) return;
    set({
      queueSessionId: sessionId,
      queuedMessages: snapshot.entries,
      queuePaused: snapshot.paused,
      queuePausedReason: snapshot.paused ? "stop" : null,
    });
  };

  const session = () => {
    const { activeSessionId, cwd } = get();
    if (!activeSessionId) throw new Error("No active conversation");
    return { sessionId: activeSessionId, cwd };
  };

  return {
    sendSteer: async (message: string, clientMessageId?: string) => {
      const { sessionId, cwd } = session();
      await getClient().sendSteer(sessionId, message, clientMessageId ?? uuidv4(), cwd);
    },
    enqueueMessage: async (message: string, clientMessageId?: string) => {
      const { sessionId, cwd } = session();
      await getClient().enqueueMessage(sessionId, message, clientMessageId ?? uuidv4(), cwd);
      await get().loadQueue();
    },
    loadQueue: async () => {
      const { activeSessionId, cwd } = get();
      if (!activeSessionId) {
        set({ queuedMessages: [], queueSessionId: null, queuePaused: false, queuePausedReason: null });
        return;
      }
      // The queue is advisory for rendering; a failed read must not break the
      // composer. User actions report their own failures.
      const snapshot = await getClient().getSessionQueue(activeSessionId, cwd).catch(() => null);
      if (snapshot) apply(cwd, activeSessionId, snapshot);
    },
    editQueuedMessage: async (entryId: string, text: string) => {
      const { sessionId, cwd } = session();
      await getClient().editQueuedMessage(sessionId, entryId, text, cwd);
      await get().loadQueue();
    },
    cancelQueuedMessage: async (entryId: string) => {
      const { sessionId, cwd } = session();
      await getClient().cancelQueuedMessage(sessionId, entryId, cwd);
      await get().loadQueue();
    },
    dispatchQueuedMessage: async (entryId: string) => {
      const { sessionId, cwd } = session();
      const receipt = await getClient().dispatchQueuedMessage(sessionId, entryId, cwd);
      await get().loadQueue();
      return receipt.status;
    },
    retryQueuedMessage: async (entryId: string) => {
      const { sessionId, cwd } = session();
      await getClient().retryQueuedMessage(sessionId, entryId, cwd);
      await get().loadQueue();
    },
    resumeQueue: async () => {
      const { sessionId, cwd } = session();
      const snapshot = await getClient().resumeQueue(sessionId, cwd);
      apply(cwd, sessionId, snapshot);
    },
  };
}
