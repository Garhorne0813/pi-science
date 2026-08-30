import type { ThreadBlock } from "../../types/thread";
import { buildTurnPresentations } from "./turn-presentation";

/** Return copy text only for the final visible answer in each completed turn. */
export function agentActionTextByBlock(blocks: ThreadBlock[]): Map<string, string> {
  const actions = new Map<string, string>();
  for (const turn of buildTurnPresentations(blocks)) {
    const finalAgent = turn.finalAgent;
    if (!finalAgent || finalAgent.partial) continue;
    const text = finalAgent.parts.map((part) => part.text).join("");
    if (text) actions.set(finalAgent.id, text);
  }
  return actions;
}

export function lastCompletedAgentMessageText(blocks: ThreadBlock[]): string {
  return [...agentActionTextByBlock(blocks).values()].at(-1) ?? "";
}
