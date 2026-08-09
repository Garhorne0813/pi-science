/** Stable marker shared by title generation and legacy-session detection. */
export const AI_TITLE_PROMPT_INSTRUCTION = "You are a helpful assistant. Write a concise title (at most 8 words) for this conversation. Reply with only the title — no quotes, no label, no punctuation decoration.";

export function isAiTitlePrompt(text: string): boolean {
  return text.startsWith(`${AI_TITLE_PROMPT_INSTRUCTION}\n\nConversation:\n`);
}
