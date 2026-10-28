import type { ThreadBlock } from "../../../types/thread";
import type { PiScienceEvent } from "../../client/pi-science-client";
import { stampCurrentUser } from "./narration";
import { markTerminalRun, numberValue, runIdentity, stringValue } from "./identity";
import type { FoldDraft } from "./types";

export function reduceRuntimeEvent(event: PiScienceEvent, { foldState, blocks, index }: FoldDraft): void {
  switch (event.type) {
    case "operation.started": {
      foldState.turnOrdinal = Math.max(foldState.turnOrdinal, Number(event.turnOrdinal) || foldState.turnOrdinal + 1);
      foldState.activeTurnId = stringValue(event.turnId) ?? `turn-${foldState.turnOrdinal}`;
      foldState.activeRunId = stringValue(event.runId);
      foldState.activeItemKey = undefined;
      stampCurrentUser(blocks, foldState.activeTurnId, foldState.activeRunId);
      break;
    }

    case "compaction.started":
    case "compaction.completed":
    case "compaction.failed":
    case "compaction.progress": {
      const status = String(event.status || "running");
      const blockId = "compaction-status";
      const block: ThreadBlock = {
        kind: "status-line",
        id: blockId,
        text: status === "end"
          ? "Conversation context compacted"
          : status === "error"
            ? `Context compaction failed${event.message ? `: ${String(event.message)}` : ""}`
            : `Compacting conversation context${event.message ? `: ${String(event.message)}` : "…"}`,
        level: status === "error" ? "error" : status === "end" ? "done" : "info",
      };
      const existing = index[blockId];
      if (existing === undefined) {
        index[blockId] = blocks.length;
        blocks.push(block);
      } else {
        blocks[existing] = block;
      }
      break;
    }

    case "plan.updated":
    case "status.updated": {
      const blockId = `runtime-status-${String(event.status || "status")}`;
      const block: ThreadBlock = {
        kind: "status-line",
        id: blockId,
        text: String(event.message || event.status || "Runtime status updated"),
        level: "info",
      };
      const existing = index[blockId];
      if (existing === undefined) {
        index[blockId] = blocks.length;
        blocks.push(block);
      } else {
        blocks[existing] = block;
      }
      break;
    }

    case "runtime.paused": {
      foldState.activeItemKey = undefined;
      foldState.activeRunId = undefined;
      break;
    }

    case "operation.settled": {
      const completedRunId = runIdentity(event, foldState);
      markTerminalRun(foldState, completedRunId, numberValue(event.seq));
      foldState.activeItemKey = undefined;
      foldState.activeRunId = undefined;
      // A run terminal event settles every item in that run. Legacy idle has
      // no run id, so retain its historical last-block behaviour.
      if (completedRunId) {
        const idleIso = new Date().toISOString();
        for (let i = 0; i < blocks.length; i += 1) {
          const block = blocks[i];
          if ((block.kind === "agent" || block.kind === "thinking") && block.partial && block.runId === completedRunId) {
            blocks[i] = block.kind === "thinking"
              ? { ...block, partial: false, endedAt: block.endedAt ?? idleIso }
              : { ...block, partial: false };
          }
        }
      } else {
        const idleIso = new Date().toISOString();
        for (let i = blocks.length - 1; i >= 0; i--) {
          const block = blocks[i];
          if ((block.kind === "agent" || block.kind === "thinking") && block.partial
            && (!foldState.activeTurnId || !block.turnId || block.turnId === foldState.activeTurnId)) {
            blocks[i] = block.kind === "thinking"
              ? { ...block, partial: false, endedAt: block.endedAt ?? idleIso }
              : { ...block, partial: false };
          }
        }
      }
      break;
    }

    case "error": {
      const msg = (event.message as string) || "Unknown error";
      const failedRunId = event.runFailed === true || event.runId ? runIdentity(event, foldState) : undefined;
      // If we already have a partial agent block without text, replace it with the error.
      // Capture this before settling the failed run, which flips `partial` to false.
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.kind === "agent" && lastBlock.partial && !lastBlock.parts?.[0]?.text) {
        blocks[blocks.length - 1] = {
          kind: "status-line",
          id: `error-${foldState.errorSerial++}`,
          turnId: stringValue(event.turnId) ?? foldState.activeTurnId,
          runId: stringValue(event.runId) ?? foldState.activeRunId,
          text: msg,
          level: "error",
        } as ThreadBlock;
        index[blocks[blocks.length - 1].id] = blocks.length - 1;
      } else {
        const errBlock: ThreadBlock = {
          kind: "status-line",
          id: `error-${foldState.errorSerial++}`,
          turnId: stringValue(event.turnId) ?? foldState.activeTurnId,
          runId: stringValue(event.runId) ?? foldState.activeRunId,
          text: msg,
          level: "error",
        };
        index[errBlock.id] = blocks.length;
        blocks.push(errBlock);
      }
      if (failedRunId) {
        markTerminalRun(foldState, failedRunId, numberValue(event.seq));
        const failedIso = new Date().toISOString();
        for (let i = 0; i < blocks.length; i += 1) {
          const block = blocks[i];
          if ((block.kind === "agent" || block.kind === "thinking") && block.partial && block.runId === failedRunId) {
            blocks[i] = block.kind === "thinking"
              ? { ...block, partial: false, endedAt: block.endedAt ?? failedIso }
              : { ...block, partial: false };
          }
        }
        foldState.activeItemKey = undefined;
        foldState.activeRunId = undefined;
      }
      break;
    }
  }
}
