import type { CompletionProvider } from "./types";
import { mentionProvider } from "./mention-provider";
import { pathProvider } from "./path-provider";
import { slashArgumentProvider } from "./slash-argument-provider";
import { slashCommandProvider } from "./slash-provider";

/** Only the first provider that claims the caret runs, so the order is the priority: a command
 *  argument owns the caret before the command name does, and an `@` mention owns it before a bare
 *  workspace path does. */
export const completionProviders: readonly CompletionProvider[] = [
  slashArgumentProvider,
  slashCommandProvider,
  mentionProvider,
  pathProvider,
];
