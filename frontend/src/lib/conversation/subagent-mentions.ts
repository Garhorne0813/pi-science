export interface SubagentMention {
  id: string;
  name: string;
  start: number;
  end: number;
}

const SUBAGENT_BLOCK = /<subagent_mentions>[\s\S]*?<\/subagent_mentions>\s*/g;
const VALID_SUBAGENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function injectSubagentMentions(message: string, mentions: SubagentMention[]): string {
  const names = [...new Set(mentions.map((mention) => mention.name).filter((name) => VALID_SUBAGENT.test(name)))];
  if (names.length === 0) return message;
  const list = names.map((name) => `- ${JSON.stringify(name)}`).join("\n");
  return `${message}\n\n<subagent_mentions>\nThe user explicitly selected the subagents below. Use the installed subagent tool to delegate the user's request to every listed agent. Treat the visible @names as recipients, not as ordinary prose. The parent remains responsible for coordinating the runs and synthesizing the final answer.\n${list}\n</subagent_mentions>`.trim();
}

export function stripSubagentMentionBlock(message: string): string {
  return message.replace(SUBAGENT_BLOCK, "").trim();
}
