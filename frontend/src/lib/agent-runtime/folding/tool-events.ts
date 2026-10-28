import type { ThreadBlock, ToolCallBlock } from "../../../types/thread";
import type { PiScienceEvent } from "../../client/pi-science-client";
import { closeOpenThinking } from "./narration";
import { eventHasIdentity, numberValue, stringValue } from "./identity";
import type { FoldDraft } from "./types";

export function reduceToolEvent(event: PiScienceEvent, { foldState, blocks, index }: FoldDraft): void {
  switch (event.type) {
    case "tool.started":
    case "tool.completed":
    case "tool.updated": {
      // A tool call supersedes reasoning: the phase is over even though the
      // run continues.
      closeOpenThinking(blocks, new Date().toISOString());
      const callId = stringValue(event.callId) ?? "unknown-call";
      const operationId = stringValue(event.operationId);
      const attemptId = stringValue(event.attemptId);
      const blockId = eventHasIdentity(event) && (operationId || attemptId)
        ? `tool-${callId}-${operationId ?? attemptId}`
        : `tool-${callId}`;
      const existingIdx = index[blockId];
      const previous = existingIdx !== undefined && blocks[existingIdx].kind === "tool"
        ? blocks[existingIdx]
        : undefined;
      const rawStatus = stringValue(event.status);
      const status: ToolCallBlock["status"] = (rawStatus === "running" || rawStatus === "done" || rawStatus === "error" || rawStatus === "waiting-approval" || rawStatus === "unknown")
        ? rawStatus
        : "unknown";
      const statusHistory = previous?.statusHistory
        ? [...previous.statusHistory, ...(previous.statusHistory.at(-1) === status ? [] : [status])]
        : [status];
      // Runtimes rarely ship wall-clock fields. Arrival times are the honest
      // fallback: first sight starts the clock, a terminal status ends it.
      const nowIso = new Date().toISOString();
      const revision = numberValue(event.revision) ?? ((previous?.revision ?? -1) + 1);
      const block: ThreadBlock = {
        kind: "tool",
        id: blockId,
        callId,
        turnId: stringValue(event.turnId) ?? previous?.turnId ?? foldState.activeTurnId,
        runId: stringValue(event.runId) ?? previous?.runId ?? foldState.activeRunId,
        ...(stringValue(event.itemId) || previous?.itemId ? { itemId: stringValue(event.itemId) ?? previous?.itemId } : {}),
        ...(stringValue(event.parentItemId) || previous?.parentItemId ? { parentItemId: stringValue(event.parentItemId) ?? previous?.parentItemId } : {}),
        revision,
        ...(numberValue(event.seq) !== undefined || previous?.sequence !== undefined ? { sequence: numberValue(event.seq) ?? previous?.sequence } : {}),
        ...(operationId || previous?.operationId ? { operationId: operationId ?? previous?.operationId } : {}),
        ...(attemptId || previous?.attemptId ? { attemptId: attemptId ?? previous?.attemptId } : {}),
        tool: (event.tool as string) || previous?.tool || "unknown",
        status,
        statusHistory,
        title: (event.title as string | undefined) ?? previous?.title,
        input: (event.input as Record<string, unknown> | undefined) ?? previous?.input,
        output: (event.output as string | undefined) ?? previous?.output,
        details: event.details ?? previous?.details,
        presentation: (event.presentation as ToolCallBlock["presentation"] | undefined) ?? previous?.presentation,
        partialOutput: (event.partialOutput as string | undefined) ?? previous?.partialOutput,
        diff: (event.diff as string | undefined) ?? previous?.diff,
        startedAt: (event.startedAt as string | undefined) ?? previous?.startedAt ?? nowIso,
        endedAt: (event.endedAt as string | undefined) ?? previous?.endedAt
          ?? ((status === "done" || status === "error") ? nowIso : undefined),
        childSessionId: (event.childSessionId as string | undefined) ?? previous?.childSessionId,
        interactionResolved: previous?.interactionResolved,
      };
      if (existingIdx !== undefined) {
        blocks[existingIdx] = block;
      } else {
        // Push to end — the agent block moves to end on each message.delta,
        // so tools naturally appear before the current agent text.
        index[blockId] = blocks.length;
        blocks.push(block);
      }
      if (event.turnId) foldState.activeTurnId = String(event.turnId);
      if (event.runId) foldState.activeRunId = String(event.runId);
      break;
    }

  }
}
