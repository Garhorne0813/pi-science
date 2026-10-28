import type { AgentMessageBlock, ThreadBlock } from "../../../types/thread";

export function updatedAgentParts(block: ThreadBlock, partId: string, text: string): AgentMessageBlock["parts"] {
  if (block.kind !== "agent") return [{ id: partId, text }];
  const existing = block.parts.findIndex((part) => part.id === partId);
  if (existing < 0) return [...block.parts, { id: partId, text }];
  return block.parts.map((part, index) => index === existing ? { id: partId, text } : part);
}

export function stampCurrentUser(blocks: ThreadBlock[], turnId: string, runId?: string): void {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind !== "user") continue;
    if (block.turnId && block.turnId !== turnId) break;
    blocks[i] = { ...block, turnId, ...(runId ? { runId } : {}) };
    break;
  }
}

/** Reasoning is a phase, not a step: it ends as soon as the model narrates or
 *  calls a tool, and the run's later completion events are only a fallback.
 *  Stamping the end when the next activity supersedes it keeps the phase
 *  duration honest when a long tool sequence follows the reasoning. */
export function closeOpenThinking(blocks: ThreadBlock[], nowIso: string, keepId?: string): void {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.kind === "thinking" && block.partial && block.id !== keepId) {
      blocks[i] = { ...block, partial: false, endedAt: block.endedAt ?? nowIso };
    }
  }
}

export type NarrationSubsumption = "keep" | "replaced" | "subsumed";

/** Some models re-narrate everything said so far at the start of every
 *  message, which stacks verbatim repeats in the feed. When a fresh
 *  narration contains the previous one, the previous block is dropped (its
 *  content lives on inside the superset, so even a streamed answer that gets
 *  echoed later stays visible through the superset); when the fresh text is
 *  itself contained, it is skipped. Explicit final candidates stay outside
 *  this heuristic in either direction. */
export function narrationSubsumption(
  previous: AgentMessageBlock,
  nextText: string,
  nextRole?: AgentMessageBlock["presentationRole"],
): NarrationSubsumption {
  if (previous.presentationRole === "final" || nextRole === "final") return "keep";
  const previousText = previous.parts.map((part) => part.text).join("").trim();
  const candidate = nextText.trim();
  if (!previousText || !candidate) return "keep";
  if (candidate === previousText) return "subsumed";
  // Only collapse substantial, near-verbatim edge echoes. Plain substring
  // matching deleted legitimate short observations such as "Done" whenever
  // a later narration happened to contain the same word.
  const shorter = Math.min(previousText.length, candidate.length);
  const longer = Math.max(previousText.length, candidate.length);
  if (shorter < 12 || shorter / longer < 0.6) return "keep";
  if (candidate.startsWith(previousText) || candidate.endsWith(previousText)) return "replaced";
  if (previousText.startsWith(candidate) || previousText.endsWith(candidate)) return "subsumed";
  return "keep";
}

/** Find the latest same-turn narration block and reconcile the incoming text
 *  against it, dropping a subsumed predecessor in place. Returns "subsumed"
 *  when the caller must not create a block for this text. */
export function reconcileRepeatedNarration(
  blocks: ThreadBlock[],
  index: Record<string, number>,
  turnId: string,
  nextText: string,
  nextRole?: AgentMessageBlock["presentationRole"],
): NarrationSubsumption {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind !== "agent") continue;
    if (block.turnId && turnId && block.turnId !== turnId) continue;
    if (block.turnId !== turnId) return "keep";
    const verdict = narrationSubsumption(block, nextText, nextRole);
    if (verdict === "replaced") {
      blocks.splice(i, 1);
      for (const id of Object.keys(index)) delete index[id];
      blocks.forEach((entry, position) => { index[entry.id] = position; });
    }
    return verdict;
  }
  return "keep";
}
