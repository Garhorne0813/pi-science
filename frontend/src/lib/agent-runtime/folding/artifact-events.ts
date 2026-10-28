import type { ThreadBlock } from "../../../types/thread";
import type { TurnArtifactItem } from "../../../types/thread";
import type { PiScienceEvent } from "../../client/pi-science-client";
import { afterAgentBlock, afterAssistantTurnEnd, afterIdentifiedTurn, afterTurnEnd, afterTurnEndedAt, isHubTurnId } from "./artifacts";
import { numberValue } from "./identity";
import type { FoldDraft } from "./types";

export function reduceArtifactEvent(event: PiScienceEvent, { foldState, blocks, index }: FoldDraft): void {
  switch (event.type) {
    case "artifact.published": {
      // Folded into the per-turn artifact summary (`turn.artifacts`); a
      // standalone status line would duplicate the strip. Publication state
      // is still tracked via `publishedArtifactPaths` for prose references.
      break;
    }

    case "artifact.updated":
    case "turn.artifacts": {
      const turnId = String(event.turnId || "");
      const items = Array.isArray(event.artifacts) ? event.artifacts as TurnArtifactItem[] : [];
      if (!turnId || items.length === 0) break;
      const blockId = `turn-artifacts-${turnId}`;
      const turnOrdinal = Number(event.turnOrdinal);
      const block: ThreadBlock = {
        kind: "artifact-summary",
        id: blockId,
        turnId,
        ...(numberValue(event.revision) !== undefined ? { revision: numberValue(event.revision) } : {}),
        ...(numberValue(event.seq) !== undefined ? { sequence: numberValue(event.seq) } : {}),
        ...(typeof event.endedAt === "string" && event.endedAt ? { endedAt: event.endedAt } : {}),
        assistantMessageId: event.assistantMessageId ? String(event.assistantMessageId) : null,
        ...(Number.isInteger(turnOrdinal) && turnOrdinal > 0 ? { turnOrdinal } : {}),
        artifacts: items,
      };
      const existing = index[blockId];
      if (existing !== undefined) {
        const previous = blocks[existing];
        const previousRevision = previous.kind === "artifact-summary" ? numberValue(previous.revision) : undefined;
        const previousSequence = previous.kind === "artifact-summary" ? numberValue(previous.sequence) : undefined;
        const incomingRevision = numberValue(event.revision);
        const previousVersioned = previousRevision !== undefined || previousSequence !== undefined;
        const incomingVersioned = incomingRevision !== undefined || numberValue(event.seq) !== undefined;
        // Versioned projection updates are strictly monotonic. Replay and late
        // delivery must never replace a newer published artifact set, and an
        // unversioned update must not roll versioned content back — same policy
        // as attachTurnArtifacts.
        if (previousVersioned && !incomingVersioned) break;
        if (previousRevision !== undefined && (incomingRevision === undefined || incomingRevision <= previousRevision)) break;
        blocks[existing] = { ...block, endedAt: block.endedAt ?? (previous.kind === "artifact-summary" ? previous.endedAt : undefined) };
        break;
      }
      let insertAt = -1;
      const assistantMessageId = block.assistantMessageId;
      if (assistantMessageId) {
        // assistantMessageId identifies the TURN, not the insertion point:
        // the strip lands after the turn's final assistant message even when
        // the id points at an intermediate message of a multi-message turn.
        insertAt = afterAssistantTurnEnd(blocks, assistantMessageId, index);
      }
      if (insertAt < 0) insertAt = afterIdentifiedTurn(blocks, turnId);
      const endedAt = typeof event.endedAt === "string" ? event.endedAt : "";
      if (insertAt < 0 && endedAt) {
        // Same primary fallback as attachTurnArtifacts: the turn's end time
        // identifies the owning turn independently of ordinals. The published
        // legacy ordinal counts artifact records; hub ordinals reset, so
        // trusting it alone drops the strip on an unrelated earlier turn.
        insertAt = afterTurnEndedAt(blocks, endedAt);
      }
      // Hub ordinals reset after restart and are never history positions.
      if (insertAt < 0 && isHubTurnId(turnId)) break;
      if (insertAt < 0 && Number.isInteger(turnOrdinal) && turnOrdinal > 0) {
        // Prefer explicit turn metadata to the current live anchor: a late
        // artifact must not attach to a newer turn that is already streaming.
        insertAt = afterTurnEnd(blocks, turnOrdinal);
      }
      const liveAnchor = foldState.lastAgentBlockId ? index[foldState.lastAgentBlockId] : undefined;
      if (insertAt < 0 && liveAnchor !== undefined) {
        // Live fold: anchor at the END of the current turn (after its last
        // assistant message), not after an intermediate message of a turn
        // that spans several assistant messages.
        insertAt = liveAnchor + 1;
      }
      if (insertAt < 0) {
        // Pi's operation.settled does not carry a message id, so summaries are
        // anchored by turn order: the n-th strip goes right after the n-th
        // agent block (live agent blocks are keyed by message.delta partId).
        const insertedBefore = blocks.filter((b) => b.kind === "artifact-summary").length;
        insertAt = afterAgentBlock(blocks, insertedBefore + 1);
      }
      if (insertAt < 0) insertAt = blocks.length;
      blocks.splice(insertAt, 0, block);
      for (const key of Object.keys(index)) {
        if (index[key] >= insertAt) index[key] += 1;
      }
      index[blockId] = insertAt;
      break;
    }

  }
}
