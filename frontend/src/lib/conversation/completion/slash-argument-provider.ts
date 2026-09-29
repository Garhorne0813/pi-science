import type { SlashCommand } from "../slash-commands";
import { tokenBounds } from "./token";
import type { CompletionContext, CompletionItem, CompletionProvider, CompletionQuery } from "./types";

const ARGUMENT = /^\/(\S+)\s+(\S*)$/;

function findCommand(name: string, commands: readonly SlashCommand[]): SlashCommand | undefined {
  return commands.find((command) => command.name === name);
}

export const slashArgumentProvider: CompletionProvider = {
  id: "slash-argument",
  trigger: "tab",

  detect(context: CompletionContext): CompletionQuery | null {
    const before = context.value.slice(0, context.caret);
    const match = ARGUMENT.exec(before);
    if (!match) return null;
    const name = match[1];
    const argument = match[2];
    const values = findCommand(name, context.commands)?.arguments?.[0]?.values;
    if (!values || values.length === 0) return null;
    return {
      providerId: "slash-argument",
      kind: "argument",
      start: context.caret - argument.length,
      end: tokenBounds(context.value, context.caret).end,
      query: argument,
      argument: { command: name, index: 0 },
    };
  },

  complete(query: CompletionQuery, context: CompletionContext): CompletionItem[] {
    const name = query.argument?.command;
    if (!name) return [];
    const spec = findCommand(name, context.commands)?.arguments?.[0];
    if (!spec?.values) return [];
    const prefix = query.query.toLowerCase();
    return spec.values
      .filter((value) => value.toLowerCase().startsWith(prefix))
      .map((value) => ({
        id: `argument:${name}:${value}`,
        kind: "argument",
        label: value,
        insertText: value,
        description: spec.name,
      }));
  },
};
