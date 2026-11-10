import type { ThreadBlock } from "../../types/thread";
import { buildTurnPresentations, type TurnPresentation } from "./turn-presentation";

/** Return copy text only for the final visible answer in each completed turn. */
export function agentActionTextByTurns(turns: readonly TurnPresentation[]): Map<string, string> {
  const actions = new Map<string, string>();
  for (const turn of turns) {
    const finalAgent = turn.finalAgent;
    if (!finalAgent || finalAgent.partial) continue;
    const text = finalAgent.parts.map((part) => part.text).join("");
    if (text) actions.set(finalAgent.id, text);
  }
  return actions;
}

/** Convenience for callers that do not already hold the turn presentations. */
export function agentActionTextByBlock(blocks: ThreadBlock[]): Map<string, string> {
  return agentActionTextByTurns(buildTurnPresentations(blocks));
}

export function lastCompletedAgentMessageText(blocks: ThreadBlock[]): string {
  return [...agentActionTextByBlock(blocks).values()].at(-1) ?? "";
}
