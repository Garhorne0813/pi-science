/** Persisted request identity and optimistic delivery reconciliation. */
import type { ThreadBlock } from "../../../types/thread";
import { getClient, type PromptRequestStatus } from "../../client/pi-science-client";
import { localPromptRequests, removeLocalPromptRequest, updateLocalPromptRequest } from "../../client/prompt-request-cache";
import type { GetState, SetState } from "./types";

function applyPromptDeliveryStatus(
  get: GetState,
  set: SetState,
  clientMessageId: string,
  status: PromptRequestStatus,
): void {
  const current = get();
  const userBlocks = current.thread.blocks.filter((block): block is Extract<ThreadBlock, { kind: "user" }> => block.kind === "user");
  const target = userBlocks.find((block) => block.client_message_id === clientMessageId);
  const blocks = current.thread.blocks.map((block) => {
    if (block.kind !== "user" || block.client_message_id !== clientMessageId) return block;
    if (status.status === "persisted") {
      return { ...block, id: status.durable_message_id ?? block.id, deliveryStatus: undefined };
    }
    return {
      ...block,
      deliveryStatus: status.status === "rejected" ? "rejected" as const
        : status.status === "indeterminate" ? "indeterminate" as const
          : "pending" as const,
    };
  });
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  const notice = status.status === "indeterminate" ? "indeterminate"
    : status.status === "pending" || status.status === "accepted" ? "pending"
      : null;
  set({
    ...(target ? { thread: { ...current.thread, blocks, index } } : {}),
    ...(current.promptDeliveryNotice === null || current.promptDeliveryNotice !== notice
      ? { promptDeliveryNotice: notice }
      : {}),
  });
}
export function updateOptimisticStatus(get: GetState, set: SetState, status: PromptRequestStatus): void {
  if (status.status === "persisted") removeLocalPromptRequest(status.client_message_id);
  else updateLocalPromptRequest(status.client_message_id, { status: status.status });
  applyPromptDeliveryStatus(get, set, status.client_message_id, status);
}
export async function restorePendingPromptRequests(
  client: ReturnType<typeof getClient>,
  cwd: string,
  sessionId: string,
  getState: GetState,
  setState: SetState,
): Promise<void> {
  for (const record of localPromptRequests(cwd, sessionId)) {
    if (getState().cwd !== cwd || getState().activeSessionId !== sessionId) return;
    try {
      const status = await client.getPromptRequestStatus(sessionId, record.clientMessageId, cwd);
      if (getState().cwd !== cwd || getState().activeSessionId !== sessionId) return;
      updateOptimisticStatus(getState, setState, status);
      if (status.status === "pending" || status.status === "accepted") {
        void monitorPromptRequest(client, cwd, sessionId, record.clientMessageId, getState, setState);
      }
    } catch {
      const status: PromptRequestStatus = {
        status: record.status === "persisted" ? "accepted" : record.status,
        client_message_id: record.clientMessageId,
      };
      applyPromptDeliveryStatus(getState, setState, record.clientMessageId, status);
    }
  }
}

export async function monitorPromptRequest(
  client: ReturnType<typeof getClient>,
  cwd: string,
  sessionId: string,
  clientMessageId: string,
  get: GetState,
  set: SetState,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const current = get();
    if (current.cwd !== cwd || current.activeSessionId !== sessionId) return;
    try {
      const status = await client.getPromptRequestStatus(sessionId, clientMessageId, cwd);
      updateOptimisticStatus(get, set, status);
      if (status.status === "persisted" || status.status === "rejected" || status.status === "indeterminate") return;
    } catch {
      // Keep the stored ID and current visual state; a later connect can
      // resume status reconciliation without copying prompt text locally.
    }
  }
}
