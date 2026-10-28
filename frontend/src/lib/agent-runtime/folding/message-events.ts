import type { ThinkingBlock, ThreadBlock } from "../../../types/thread";
import type { PiScienceEvent } from "../../client/pi-science-client";
import { closeOpenThinking, reconcileRepeatedNarration, stampCurrentUser, updatedAgentParts } from "./narration";
import { eventHasIdentity, eventItemKey, eventTextKey, numberValue, roleOf, runIdentity, stringValue, turnIdentity } from "./identity";
import { ownerScopedBlockId } from "./ownership";
import type { FoldDraft } from "./types";

export function reduceMessageEvent(event: PiScienceEvent, { foldState, blocks, index }: FoldDraft): void {
  switch (event.type) {
    case "message.started": {
      if (event.turnId) foldState.activeTurnId = String(event.turnId);
      if (event.runId) foldState.activeRunId = String(event.runId);
      if (event.itemId) foldState.activeItemKey = String(event.itemId);
      break;
    }

    case "message.completed": {
      const itemId = stringValue(event.itemId) ?? stringValue(event.partId);
      const completedRevision = numberValue(event.revision);
      const completedSequence = numberValue(event.seq);
      const content = itemId ? foldState.textByKey[itemId] ?? foldState.thinkingByKey[itemId] : undefined;
      const blockIndex = content ? index[content.blockId] : undefined;
      if (blockIndex !== undefined && (blocks[blockIndex]?.kind === "agent" || blocks[blockIndex]?.kind === "thinking")) {
        const completed = blocks[blockIndex];
        blocks[blockIndex] = completed.kind === "thinking"
          ? { ...completed, ...(completedRevision !== undefined ? { revision: completedRevision } : {}), ...(completedSequence !== undefined ? { sequence: completedSequence } : {}), partial: false, endedAt: completed.endedAt ?? new Date().toISOString() }
          : { ...completed, ...(completedRevision !== undefined ? { revision: completedRevision } : {}), ...(completedSequence !== undefined ? { sequence: completedSequence } : {}), partial: false };
      } else if (itemId) {
        for (let i = 0; i < blocks.length; i += 1) {
          const block = blocks[i];
          if ((block.kind === "agent" || block.kind === "thinking") && (block.itemId === itemId || block.id === itemId)) {
            blocks[i] = block.kind === "thinking"
              ? { ...block, ...(completedRevision !== undefined ? { revision: completedRevision } : {}), ...(completedSequence !== undefined ? { sequence: completedSequence } : {}), partial: false, endedAt: block.endedAt ?? new Date().toISOString() }
              : { ...block, ...(completedRevision !== undefined ? { revision: completedRevision } : {}), ...(completedSequence !== undefined ? { sequence: completedSequence } : {}), partial: false };
          }
        }
      }
      break;
    }

    case "message.delta": {
      closeOpenThinking(blocks, new Date().toISOString());
      const explicit = eventHasIdentity(event);
      const eventPartId = stringValue(event.partId) ?? (explicit ? stringValue(event.itemId) : undefined);
      const key = eventTextKey(event, foldState);
      const previousKey = foldState.activeItemKey;
      if (eventPartId && previousKey && eventPartId !== previousKey && !explicit) {
        const previousText = foldState.textByKey[previousKey];
        const previousIdx = previousText ? index[previousText.blockId] : undefined;
        const previous = previousIdx !== undefined ? blocks[previousIdx] : undefined;
        if (previousIdx !== undefined && previous?.kind === "agent" && previous.partial) {
          blocks[previousIdx] = { ...previous, partial: false };
        }
        foldState.activeItemKey = eventPartId;
      } else if (eventPartId && !foldState.activeItemKey) {
        foldState.activeItemKey = eventPartId;
      }
      const incomingText = (event.text as string) || "";
      const previousText = foldState.textByKey[key];
      let nextText = event.replace === true ? incomingText : (previousText?.text ?? "") + incomingText;
      // Skip initial empty text events that create placeholder agent blocks
      // (DeepSeek sends empty message.delta between tool calls before real text)
      const hasText = nextText.trim().length > 0;
      const turnId = turnIdentity(event, foldState);
      const runId = runIdentity(event, foldState);
      foldState.activeTurnId = turnId;
      if (runId) foldState.activeRunId = runId;
      stampCurrentUser(blocks, turnId, runId);
      const role = roleOf(event);
      const revision = numberValue(event.revision) ?? ((previousText?.revision ?? 0) + 1);
      if (!hasText) {
        foldState.textByKey[key] = {
          text: nextText,
          revision,
          blockId: previousText?.blockId ?? (explicit ? `agent-${turnId}-${stringValue(event.itemId) ?? key}` : key),
          partId: eventPartId ?? key,
          ...(previousText?.suppressed ? { suppressed: true } : {}),
        };
        break;
      }
      let blockId = previousText?.blockId ?? (explicit ? `agent-${turnId}-${stringValue(event.itemId) ?? key}` : (eventPartId ?? key));
      // This owner's own view has no entry for the key, so a block under this
      // id belongs to an earlier turn: materialize a separate one instead of
      // rewriting that turn's answer.
      blockId = ownerScopedBlockId(blocks, index, blockId, foldState.contentStateOwner);
      const existingIdx = index[blockId];
      if (existingIdx !== undefined) {
        const hasToolsAfter = blocks.slice(existingIdx + 1).some((b) => b.kind === "tool");
        if (hasToolsAfter && !explicit) {
          // Pre-tool text → finalize old block; redirect turn ID to new post-tool block
          const oldBlock = blocks[existingIdx];
          if (oldBlock.kind === "agent") {
            blocks[existingIdx] = { ...oldBlock, partial: false };
          }
          nextText = incomingText;
          blockId = `${blockId}-post`;
          // A stream can reuse a part id after a tool. Keep the
          // compatibility split deterministic while leaving Versioned item ids
          // single-writer and stable.
          let postId = blockId;
          let suffix = 2;
          while (index[postId] !== undefined) postId = `${blockId}-${suffix++}`;
          blockId = postId;
          if (reconcileRepeatedNarration(blocks, index, turnId, nextText, role) === "subsumed") {
            foldState.textByKey[key] = { text: nextText, revision, blockId, partId: eventPartId ?? key, suppressed: true };
            break;
          }
          foldState.activeItemKey = blockId;
          index[blockId] = blocks.length;
          foldState.lastAgentBlockId = blockId;
          blocks.push({
            kind: "agent",
            id: blockId,
            turnId,
            ...(runId ? { runId } : {}),
            itemId: stringValue(event.itemId) ?? eventPartId,
            parts: [{ id: eventPartId ?? blockId, text: nextText }],
            ...(role ? { presentationRole: role } : {}),
            classificationSource: role ? "explicit" : "legacy_inferred",
            revision,
            ...(numberValue(event.seq) !== undefined ? { sequence: numberValue(event.seq) } : {}),
            partial: true,
            timestamp: new Date().toISOString(),
          });
        } else {
          blocks[existingIdx] = {
            ...blocks[existingIdx],
            kind: "agent",
            turnId,
            ...(runId ? { runId } : {}),
            itemId: stringValue(event.itemId) ?? eventPartId ?? (blocks[existingIdx].kind === "agent" ? blocks[existingIdx].itemId : undefined),
            parts: updatedAgentParts(blocks[existingIdx], eventPartId ?? blockId, nextText),
            ...(role ? { presentationRole: role, classificationSource: "explicit" as const } : {}),
            revision,
            ...(numberValue(event.seq) !== undefined ? { sequence: numberValue(event.seq) } : {}),
            partial: true,
            timestamp: blocks[existingIdx].kind === "agent" ? blocks[existingIdx].timestamp : undefined,
          } as ThreadBlock;
          foldState.lastAgentBlockId = blockId;
        }
      } else {
        // New block for this turn. Some models re-narrate everything said so
        // far at the start of every message; collapse the verbatim repeat
        // instead of stacking another copy in the feed.
        if (reconcileRepeatedNarration(blocks, index, turnId, nextText, role) === "subsumed") {
          foldState.textByKey[key] = { text: nextText, revision, blockId, partId: eventPartId ?? key, suppressed: true };
          break;
        }
        const block: ThreadBlock = {
          kind: "agent",
          id: blockId,
          turnId,
          ...(runId ? { runId } : {}),
          ...(stringValue(event.itemId) || eventPartId ? { itemId: stringValue(event.itemId) ?? eventPartId } : {}),
          parts: [{ id: eventPartId ?? blockId, text: nextText }],
          ...(role ? { presentationRole: role } : {}),
          classificationSource: role ? "explicit" : "legacy_inferred",
          revision,
          ...(numberValue(event.seq) !== undefined ? { sequence: numberValue(event.seq) } : {}),
          partial: true,
          timestamp: new Date().toISOString(),
        };
        index[blockId] = blocks.length;
        foldState.lastAgentBlockId = blockId;
        blocks.push(block);
      }
      foldState.textByKey[key] = { text: nextText, revision, blockId, partId: eventPartId ?? key };
      foldState.activeItemKey = key;
      break;
    }

    case "message.reasoning.delta": {
      // The reasoning stream stays out of the text state machine: thinking and
      // narration interleave freely, and neither should finalize the other.
      const nowIso = new Date().toISOString();
      const incomingText = (event.text as string) || "";
      const eventPartId = stringValue(event.partId) ?? stringValue(event.itemId);
      const key = `thinking:${eventPartId ?? eventItemKey(event, foldState)}`;
      const previous = foldState.thinkingByKey[key];
      const nextText = event.replace === true ? incomingText : (previous?.text ?? "") + incomingText;
      const revision = numberValue(event.revision) ?? ((previous?.revision ?? 0) + 1);
      const turnId = turnIdentity(event, foldState);
      const runId = runIdentity(event, foldState);
      const blockId = ownerScopedBlockId(
        blocks,
        index,
        previous?.blockId ?? `thinking-${turnId}-${eventPartId ?? key}`,
        foldState.contentStateOwner,
      );
      // A different reasoning item taking over ends the previous phase.
      closeOpenThinking(blocks, nowIso, blockId);
      if (nextText.trim()) {
        const existingIdx = index[blockId];
        if (existingIdx !== undefined && blocks[existingIdx].kind === "thinking") {
          const existing = blocks[existingIdx] as ThinkingBlock;
          blocks[existingIdx] = {
            ...existing,
            parts: [{ id: blockId, text: nextText }],
            partial: true,
            // Resuming a phase that was already closed restarts its clock, so
            // the row never reports a stale end time as its duration.
            startedAt: existing.partial ? existing.startedAt ?? nowIso : nowIso,
            endedAt: undefined,
            turnId,
            ...(runId ? { runId } : {}),
            revision,
            ...(numberValue(event.seq) !== undefined ? { sequence: numberValue(event.seq) } : {}),
          } as ThreadBlock;
        } else {
          index[blockId] = blocks.length;
          blocks.push({
            kind: "thinking",
            id: blockId,
            turnId,
            ...(runId ? { runId } : {}),
            ...(stringValue(event.itemId) || eventPartId ? { itemId: stringValue(event.itemId) ?? eventPartId } : {}),
            parts: [{ id: blockId, text: nextText }],
            revision,
            ...(numberValue(event.seq) !== undefined ? { sequence: numberValue(event.seq) } : {}),
            partial: true,
            startedAt: nowIso,
            timestamp: nowIso,
          } as ThreadBlock);
        }
      }
      foldState.thinkingByKey[key] = {
        text: nextText,
        revision,
        blockId,
        partId: eventPartId ?? key,
        ...(previous?.segments ? { segments: previous.segments } : {}),
      };
      break;
    }

  }
}
