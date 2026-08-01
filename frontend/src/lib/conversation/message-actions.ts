import type { ThreadBlock } from "../../types/thread";

/**
 * Returns copy text only for the final agent block in each completed turn.
 * Tool calls can split one assistant response into several visual blocks, but
 * the response should still expose a single action row.
 */
export function agentActionTextByBlock(blocks: ThreadBlock[]): Map<string, string> {
  const actions = new Map<string, string>();
  let turn: ThreadBlock[] = [];

  const finishTurn = () => {
    const agents = turn.filter(
      (block): block is Extract<ThreadBlock, { kind: "agent" }> => block.kind === "agent",
    );
    const finalAgent = agents.at(-1);
    if (!finalAgent || finalAgent.partial) return;

    const finalIndex = turn.lastIndexOf(finalAgent);
    const hasTrailingTool = turn.slice(finalIndex + 1).some((block) => block.kind === "tool");
    if (hasTrailingTool) return;

    const text = agents
      .map((block) => block.parts.map((part) => part.text).join(""))
      .filter(Boolean)
      .join("\n\n");
    if (text) actions.set(finalAgent.id, text);
  };

  for (const block of blocks) {
    if (block.kind === "user") {
      finishTurn();
      turn = [];
      continue;
    }
    turn.push(block);
  }
  finishTurn();
  return actions;
}

export function lastCompletedAgentMessageText(blocks: ThreadBlock[]): string {
  return [...agentActionTextByBlock(blocks).values()].at(-1) ?? "";
}
