/** Model menu helpers shared by the conversation and settings surfaces. */

import type { AvailableModel } from "./types";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Conversation model menus expose every configured provider, including custom providers. */
export function conversationModelOptions(models: AvailableModel[]): AvailableModel[] {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

/** Keep the current Think setting valid when the selected model changes. */
export function clampThinkingLevel(requested: string, supported: string[]): string {
  if (supported.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested as typeof THINKING_LEVELS[number]);
  const start = requestedIndex === -1 ? 0 : requestedIndex;
  return THINKING_LEVELS.slice(start).find((level) => supported.includes(level))
    || [...THINKING_LEVELS].slice(0, start).reverse().find((level) => supported.includes(level))
    || supported[0]
    || "off";
}
