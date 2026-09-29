import { commandHint, commandTakesArguments, matchCommands } from "../slash-commands";
import { tokenBounds } from "./token";
import type { CompletionContext, CompletionItem, CompletionProvider, CompletionQuery } from "./types";

export const slashCommandProvider: CompletionProvider = {
  id: "slash",
  trigger: "typing",

  detect(context: CompletionContext): CompletionQuery | null {
    const before = context.value.slice(0, context.caret);
    if (!before.startsWith("/") || /\s/.test(before)) return null;
    return { providerId: "slash", kind: "command", start: 0, end: tokenBounds(context.value, context.caret).end, query: before.slice(1) };
  },

  complete(query: CompletionQuery, context: CompletionContext): CompletionItem[] {
    return matchCommands(query.query, context.commands).map((command) => ({
      id: `command:${command.name}`,
      kind: "command",
      label: `/${command.name}`,
      description: command.description,
      detail: commandHint(command),
      insertText: `/${command.name}${commandTakesArguments(command) ? " " : ""}`,
    }));
  },
};
