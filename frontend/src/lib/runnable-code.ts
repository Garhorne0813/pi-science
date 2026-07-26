/** Pure helpers for executable chat code blocks: which fenced blocks can run
 *  on the scientific kernel bridge (see components/conversation/RunnableCodeBlock). */

/** Fence language from react-markdown's code className ("language-python" → "python"). */
export function fenceLanguage(className?: string): string | null {
  const match = /(?:^|\s)language-([\w+-]+)/.exec(className ?? "");
  return match ? match[1].toLowerCase() : null;
}

/** Fence-language aliases the chat Run affordance supports; only python for now. */
const RUNNABLE_ALIASES: Record<string, "python"> = { python: "python", py: "python" };

/** Kernel language for a fence language, or null when the block is not runnable. */
export function runnableLanguage(language: string | null): "python" | null {
  return language ? RUNNABLE_ALIASES[language] ?? null : null;
}
