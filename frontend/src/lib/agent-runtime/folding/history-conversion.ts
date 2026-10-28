/** Convert durable history messages into presentation blocks without runtime side effects. */
import type { ThreadBlock, ToolCallBlock } from "../../../types/thread";
import type { HistoryMessage } from "../../client/pi-science-client";
import { type NarrationSubsumption, narrationSubsumption } from "./narration";
import type { Thread } from "./types";
import { recordValue } from "./identity";

export function threadFromMessages(messages: HistoryMessage[]): Thread {
  const blocks = convertHistoryToBlocks(messages);
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: true };
}

export function convertHistoryToBlocks(messages: HistoryMessage[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, Record<string, unknown>>();
  const toolPresentations = new Map<string, ToolCallBlock["presentation"]>();
  const toolBlockIndexes = new Map<string, number>();
  // The assistant message that carries a toolCall is the call's start wall
  // clock; the toolResult message is its end. Together they reconstruct the
  // per-step and whole-process durations that live events provide.
  const toolCallStarts = new Map<string, string>();

  for (const msg of messages) {
    const role = msg.role;
    if (role === "user") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      const images = msg.content.flatMap((content: any) => {
        if (content.type !== "image" && content.type !== "input_image") return [];
        const source = content.source && typeof content.source === "object" ? content.source : content;
        const data = typeof source.data === "string" ? source.data : "";
        const mimeType = typeof source.media_type === "string" ? source.media_type : typeof content.mimeType === "string" ? content.mimeType : typeof content.mime === "string" ? content.mime : "image/png";
        return data ? [{ data, mimeType }] : [];
      });
      if (text || images.length > 0) blocks.push({
        kind: "user",
        id: msg.id,
        ...(msg.client_message_id ? { client_message_id: msg.client_message_id } : {}),
        text,
        ...(images.length > 0 ? { images } : {}),
        ...(msg.turnStatus ? { turnStatus: msg.turnStatus, turnStartedAt: msg.turnStartedAt, turnEndedAt: msg.turnEndedAt } : {}),
        ...(msg.turnId ? { turnId: msg.turnId } : {}),
        ...(msg.runId ? { runId: msg.runId } : {}),
        ...(msg.itemId ? { itemId: msg.itemId } : {}),
        timestamp: msg.timestamp,
      });
    } else if (role === "assistant") {
      const messageToolCalls: Array<{ callId: string; tool: string }> = [];
      for (const content of msg.content) {
        if (content.type !== "toolCall") continue;
        const callId = String(content.id || "");
        if (callId) {
          const tool = String(content.name || content.tool || "unknown");
          toolNames.set(callId, tool);
          const input = recordValue(content.arguments ?? content.args ?? content.input);
          if (Object.keys(input).length > 0) toolInputs.set(callId, input);
          if (content.presentation && typeof content.presentation === "object") toolPresentations.set(callId, content.presentation as ToolCallBlock["presentation"]);
          if (msg.timestamp) toolCallStarts.set(callId, msg.timestamp);
          messageToolCalls.push({ callId, tool });
        }
      }
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      // Reasoning precedes the answer in the content array; rebuild it as its
      // own block so restored turns show the same thinking rows as live ones.
      const thinking = msg.content
        .filter((c: any) => c.type === "thinking")
        .map((c: any) => (typeof c.thinking === "string" ? c.thinking : ""))
        .filter(Boolean)
        .join("\n");
      if (thinking) {
        blocks.push({
          kind: "thinking",
          id: `${msg.id}-thinking`,
          ...(msg.turnStatus ? { turnStatus: msg.turnStatus, turnStartedAt: msg.turnStartedAt, turnEndedAt: msg.turnEndedAt } : {}),
          ...(msg.turnId ? { turnId: msg.turnId } : {}),
          ...(msg.runId ? { runId: msg.runId } : {}),
          ...(msg.itemId ? { itemId: msg.itemId } : {}),
          parts: [{ id: `${msg.id}-thinking-0`, text: thinking }],
          timestamp: msg.timestamp,
        });
      }
      if (text) {
        // Collapse models that repeat their previous narration in every
        // message: the union stays, the verbatim repeat goes. The matcher
        // itself owns the explicit-final guard so live/history stay aligned.
        let subsumed: NarrationSubsumption = "keep";
        for (let i = blocks.length - 1; i >= 0; i -= 1) {
          const block = blocks[i];
          if (block.kind === "user") break;
          if (block.kind !== "agent") continue;
          if (block.turnId && msg.turnId && block.turnId !== msg.turnId) continue;
          if (block.turnId !== msg.turnId) break;
          subsumed = narrationSubsumption(block, text, msg.presentationRole);
          if (subsumed === "replaced") blocks.splice(i, 1);
          break;
        }
        if (subsumed !== "subsumed") {
          blocks.push({
            kind: "agent",
            id: msg.id,
            parts: [{ id: msg.itemId ?? msg.id, text }],
            ...(msg.turnStatus ? { turnStatus: msg.turnStatus, turnStartedAt: msg.turnStartedAt, turnEndedAt: msg.turnEndedAt } : {}),
            ...(msg.turnId ? { turnId: msg.turnId } : {}),
            ...(msg.runId ? { runId: msg.runId } : {}),
            ...(msg.itemId ? { itemId: msg.itemId } : {}),
            ...(msg.parentItemId ? { parentItemId: msg.parentItemId } : {}),
            ...(msg.presentationRole ? { presentationRole: msg.presentationRole } : {}),
            ...(msg.classificationSource ? { classificationSource: msg.classificationSource } : {}),
            ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
            ...(msg.sequence !== undefined ? { sequence: msg.sequence } : {}),
            timestamp: msg.timestamp,
          });
        }
      }
      // Materialize calls at their invocation point instead of waiting for a
      // result message. This preserves interrupted/orphan calls after refresh
      // and lets the later result update the same chronological step.
      for (const { callId, tool } of messageToolCalls) {
        if (toolBlockIndexes.has(callId)) continue;
        const block: ToolCallBlock = {
          kind: "tool",
          id: `tool-${callId}`,
          callId,
          ...(msg.turnStatus ? { turnStatus: msg.turnStatus, turnStartedAt: msg.turnStartedAt, turnEndedAt: msg.turnEndedAt } : {}),
          ...(msg.turnId ? { turnId: msg.turnId } : {}),
          ...(msg.runId ? { runId: msg.runId } : {}),
          tool,
          status: "running",
          statusHistory: ["running"],
          input: toolInputs.get(callId),
          presentation: toolPresentations.get(callId),
          ...(msg.timestamp ? { startedAt: msg.timestamp } : {}),
        };
        toolBlockIndexes.set(callId, blocks.length);
        blocks.push(block);
      }
    } else if (role === "toolResult") {
      const callId = msg.toolCallId || msg.id;
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      const nonTextContent = msg.content.filter((content) => content.type !== "text");
      const details = nonTextContent.length === 0
        ? msg.details
        : msg.details === undefined
          ? { content: nonTextContent }
          : { details: msg.details, content: nonTextContent };
      const previousIndex = toolBlockIndexes.get(callId);
      const previous = previousIndex === undefined ? undefined : blocks[previousIndex];
      const block: ToolCallBlock = {
        kind: "tool",
        id: `tool-${callId}`,
        callId,
        ...(msg.turnStatus ? { turnStatus: msg.turnStatus, turnStartedAt: msg.turnStartedAt, turnEndedAt: msg.turnEndedAt } : {}),
        ...(msg.turnId || (previous?.kind === "tool" && previous.turnId) ? { turnId: msg.turnId ?? (previous?.kind === "tool" ? previous.turnId : undefined) } : {}),
        ...(msg.runId || (previous?.kind === "tool" && previous.runId) ? { runId: msg.runId ?? (previous?.kind === "tool" ? previous.runId : undefined) } : {}),
        ...(msg.itemId ? { itemId: msg.itemId } : {}),
        tool: msg.toolName || toolNames.get(callId) || "unknown",
        status: msg.isError ? "error" as const : "done" as const,
        statusHistory: previous?.kind === "tool" ? [...(previous.statusHistory ?? [previous.status]), msg.isError ? "error" : "done"] : [msg.isError ? "error" : "done"],
        input: toolInputs.get(callId) ?? (previous?.kind === "tool" ? previous.input : undefined),
        output: text || undefined,
        details,
        presentation: msg.presentation ?? toolPresentations.get(callId),
        ...(toolCallStarts.get(callId) ? { startedAt: toolCallStarts.get(callId) } : {}),
        ...(msg.timestamp ? { endedAt: msg.timestamp } : {}),
      };
      if (previousIndex === undefined) {
        toolBlockIndexes.set(callId, blocks.length);
        blocks.push(block);
      } else {
        blocks[previousIndex] = block;
      }
    }
  }
  return blocks;
}
