import type { AgentMessageBlock, ThreadBlock } from "../../types/thread";
import { activityPolicy, isVisibleActivity } from "./activity-policy";

/** Structural pick of the answer of a COMPLETED turn: the last agent block
 *  that no later visible-activity tool supersedes. Never call this for a live
 *  turn: its "no trailing tool" state just means the next tool has not
 *  arrived yet, which is what made provisional narration flicker as an answer. */
export function finalAgentInCompletedTurn(blocks: ThreadBlock[]): AgentMessageBlock | null {
  const candidate = latestUnsupersededAgent(blocks);
  if (!candidate) return null;
  const candidateIndex = blocks.indexOf(candidate);
  const trailingPlan = blocks.slice(candidateIndex + 1).some((block) => block.kind === "tool" && activityPolicy(block).plane === "plan-control");
  const executionBeforeCandidate = blocks.slice(0, candidateIndex).some((block) => block.kind === "tool" && activityPolicy(block).plane !== "plan-control");
  return trailingPlan && !executionBeforeCandidate ? null : candidate;
}

/** The newest agent block of an ACTIVE turn that no visible tool has taken
 *  over yet. It may still turn out to be narration, but exposing it lets the
 *  conversation render text deltas instead of waiting for the turn to settle. */
export function provisionalAgentInActiveTurn(blocks: ThreadBlock[]): AgentMessageBlock | null {
  return latestUnsupersededAgent(blocks);
}

export function intermediateAgentsInTurn(blocks: ThreadBlock[]): AgentMessageBlock[] {
  const structural = latestUnsupersededAgent(blocks);
  return blocks.filter((block): block is AgentMessageBlock => block.kind === "agent" && block !== structural);
}

function latestUnsupersededAgent(blocks: ThreadBlock[]): AgentMessageBlock | null {
  return blocks.findLast((block, index): block is AgentMessageBlock => block.kind === "agent" && !blocks.slice(index + 1).some((candidate) => candidate.kind === "tool" && isVisibleActivity(candidate))) ?? null;
}
