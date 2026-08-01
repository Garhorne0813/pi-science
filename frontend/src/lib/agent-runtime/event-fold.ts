/** Thread model and transport event folding (ported from open-science foldEvent).
 *
 *  The turn buffer below is module-level mutable state owned by this module:
 *  `foldEvent` accumulates text deltas across events of the same agent turn.
 *  Every code path that starts or abandons a turn (connect, sendPrompt,
 *  agent_start, stream.gap, session replacement, missing-session recovery)
 *  clears it through `resetTurnBuffer()`. */

import type { ThreadBlock } from "../../types/thread";
import type { HistoryMessage, PiScienceEvent } from "../client/pi-science-client";

export interface Thread {
  blocks: ThreadBlock[];
  /** Map from block id to index in blocks array */
  index: Record<string, number>;
  loaded: boolean;
}

export function emptyThread(): Thread {
  return { blocks: [], index: {}, loaded: false };
}

let _textBuffer = ""; // Accumulates text deltas
let _currentTurnId = ""; // Unique ID per agent turn, resets on agent_start

/** Drop the accumulated text of the current turn. Called by every path that
 *  begins a new turn or invalidates the one in flight. */
export function resetTurnBuffer(): void {
  _textBuffer = "";
  _currentTurnId = "";
}

export function foldEvent(state: Thread, event: PiScienceEvent): Thread {
  const blocks = [...state.blocks];
  const index = { ...state.index };

  switch (event.type) {
    case "text.updated": {
      const eventPartId = typeof event.partId === "string" && event.partId
        ? event.partId
        : null;
      if (eventPartId && _currentTurnId && eventPartId !== _currentTurnId) {
        const previousIdx = index[_currentTurnId];
        const previous = previousIdx !== undefined ? blocks[previousIdx] : undefined;
        if (previous?.kind === "agent" && previous.partial) {
          blocks[previousIdx] = { ...previous, partial: false };
        }
        _textBuffer = "";
        _currentTurnId = eventPartId;
      } else if (eventPartId && !_currentTurnId) {
        _currentTurnId = eventPartId;
      }
      const incomingText = (event.text as string) || "";
      _textBuffer = event.replace === true ? incomingText : _textBuffer + incomingText;
      // Skip initial empty text events that create placeholder agent blocks
      // (DeepSeek sends empty text.updated between tool calls before real text)
      const hasText = _textBuffer.trim().length > 0;
      if (!hasText) break;  // Don't create/update agent block for empty text
      const turnId = _currentTurnId || `agent-${Date.now()}`;
      if (!_currentTurnId) _currentTurnId = turnId;
      const blockId = turnId;
      const existingIdx = index[blockId];
      if (existingIdx !== undefined) {
        const hasToolsAfter = blocks.slice(existingIdx + 1).some((b) => b.kind === "tool");
        if (hasToolsAfter) {
          // Pre-tool text → finalize old block; redirect turn ID to new post-tool block
          const oldBlock = blocks[existingIdx];
          if (oldBlock.kind === "agent") {
            blocks[existingIdx] = { ...oldBlock, partial: false };
          }
          _textBuffer = (event.text as string) || "";
          // Update turn ID so subsequent events find this post-tool block
          _currentTurnId = turnId + "-post";
          index[turnId + "-post"] = blocks.length;
          blocks.push({
            kind: "agent",
            id: turnId + "-post",
            parts: [{ id: turnId + "-post", text: _textBuffer }],
            partial: true,
            timestamp: new Date().toISOString(),
          } as ThreadBlock);
        } else {
          blocks[existingIdx] = {
            ...blocks[existingIdx],
            kind: "agent",
            parts: [{ id: turnId, text: _textBuffer }],
            partial: true,
            timestamp: blocks[existingIdx].kind === "agent" ? blocks[existingIdx].timestamp : undefined,
          } as ThreadBlock;
        }
      } else {
        // New block for this turn
        const block: ThreadBlock = {
          kind: "agent",
          id: blockId,
          parts: [{ id: turnId, text: _textBuffer }],
          partial: true,
          timestamp: new Date().toISOString(),
        };
        index[blockId] = blocks.length;
        blocks.push(block);
      }
      break;
    }

    case "tool.updated": {
      const callId = event.callId as string;
      const blockId = `tool-${callId}`;
      const existingIdx = index[blockId];
      const previous = existingIdx !== undefined && blocks[existingIdx].kind === "tool"
        ? blocks[existingIdx]
        : undefined;
      const block: ThreadBlock = {
        kind: "tool",
        id: blockId,
        callId,
        tool: (event.tool as string) || previous?.tool || "unknown",
        status: event.status as ThreadBlock extends { status: infer S } ? S : never,
        title: (event.title as string | undefined) ?? previous?.title,
        input: (event.input as Record<string, unknown> | undefined) ?? previous?.input,
        output: (event.output as string | undefined) ?? previous?.output,
        partialOutput: (event.partialOutput as string | undefined) ?? previous?.partialOutput,
        diff: (event.diff as string | undefined) ?? previous?.diff,
        startedAt: (event.startedAt as string | undefined) ?? previous?.startedAt,
        endedAt: (event.endedAt as string | undefined) ?? previous?.endedAt,
        childSessionId: (event.childSessionId as string | undefined) ?? previous?.childSessionId,
      };
      if (existingIdx !== undefined) {
        blocks[existingIdx] = block;
      } else {
        // Push to end — the agent block moves to end on each text.updated,
        // so tools naturally appear before the current agent text.
        index[blockId] = blocks.length;
        blocks.push(block);
      }
      break;
    }

    case "artifact.published": {
      const artifactId = String(event.artifactId || "");
      const path = String(event.path || "");
      const verification = event.verification as { status?: string } | undefined;
      const block: ThreadBlock = {
        kind: "status-line",
        id: `artifact-${artifactId || path}-${String(event.version || "")}`,
        text: `Published artifact: ${path}${artifactId ? ` (${artifactId})` : ""}`,
        level: verification?.status === "failed" ? "warn" : "done",
        artifactId,
        path,
      };
      index[block.id] = blocks.length;
      blocks.push(block);
      break;
    }

    case "compaction.updated": {
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

    case "session.idle": {
      _textBuffer = "";
      _currentTurnId = "";  // Reset for next turn
      // Mark last agent block as not partial
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.kind === "agent" && block.partial) {
          blocks[i] = { ...block, partial: false };
          break;
        }
      }
      break;
    }

    case "error": {
      const msg = (event.message as string) || "Unknown error";
      // If we already have a partial agent block without text, replace it with the error
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.kind === "agent" && lastBlock.partial && !lastBlock.parts?.[0]?.text) {
        blocks[blocks.length - 1] = {
          kind: "status-line",
          id: `error-${Date.now()}`,
          text: msg,
          level: "error",
        } as ThreadBlock;
        index[blocks[blocks.length - 1].id] = blocks.length - 1;
      } else {
        const errBlock: ThreadBlock = {
          kind: "status-line",
          id: `error-${Date.now()}`,
          text: msg,
          level: "error",
        };
        index[errBlock.id] = blocks.length;
        blocks.push(errBlock);
      }
      break;
    }
  }

  return { blocks, index, loaded: true };
}

export function threadFromMessages(messages: HistoryMessage[]): Thread {
  const blocks = convertHistoryToBlocks(messages);
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: true };
}

export function mergeHistoryWithLive(history: Thread, live: Thread): Thread {
  if (live.blocks.length === 0) return history;
  const ids = new Set(history.blocks.map((block) => block.id));
  const toolCallIds = new Set(
    history.blocks
      .filter((block): block is Extract<ThreadBlock, { kind: "tool" }> => block.kind === "tool")
      .map((block) => block.callId),
  );
  const blocks = [...history.blocks];
  for (const block of live.blocks) {
    if (ids.has(block.id)) continue;
    if (block.kind === "tool" && toolCallIds.has(block.callId)) continue;
    blocks.push(block);
    ids.add(block.id);
    if (block.kind === "tool") toolCallIds.add(block.callId);
  }
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: true };
}

export function convertHistoryToBlocks(messages: HistoryMessage[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  const toolNames = new Map<string, string>();

  for (const msg of messages) {
    const role = msg.role;
    if (role === "user") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) blocks.push({ kind: "user", id: msg.id, text, timestamp: msg.timestamp });
    } else if (role === "assistant") {
      for (const content of msg.content) {
        if (content.type !== "toolCall") continue;
        const callId = String(content.id || "");
        if (callId) {
          toolNames.set(callId, String(content.name || content.tool || "unknown"));
        }
      }
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) {
        blocks.push({ kind: "agent", id: msg.id, parts: [{ id: msg.id, text }], timestamp: msg.timestamp });
      }
    } else if (role === "toolResult") {
      const callId = msg.toolCallId || msg.id;
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      blocks.push({
        kind: "tool",
        id: `tool-${callId}`,
        callId,
        tool: msg.toolName || toolNames.get(callId) || "unknown",
        status: msg.isError ? "error" as const : "done" as const,
        output: text || undefined,
      });
    }
  }
  return blocks;
}
