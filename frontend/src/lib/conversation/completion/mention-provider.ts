import { compareEntries, splitPathToken } from "./path-provider";
import { tokenBounds } from "./token";
import type { CompletionContext, CompletionItem, CompletionProvider, CompletionQuery } from "./types";

/** The `@` trigger plus everything the user typed after it. A mention token never spans
 *  whitespace: the token ends where the next word starts. */
const TRIGGER_AT = /(?:^|[\s([{])@([^\s]*)$/;

function mentionDirectory(token: string) {
  const directory = splitPathToken(token);
  if (!directory) return null;
  // A bare `@` answers with agents only. Listing every root entry there would bury them, so a
  // file listing needs a prefix, or an explicit `@dir/`.
  return directory.prefix || token.endsWith("/") ? directory : null;
}

export const mentionProvider: CompletionProvider = {
  id: "mention",
  trigger: "typing",

  detect(context: CompletionContext): CompletionQuery | null {
    const match = context.value.slice(0, context.caret).match(TRIGGER_AT);
    if (!match) return null;
    const token = match[1];
    const directory = mentionDirectory(token);
    return {
      providerId: "mention",
      kind: "subagent",
      start: context.caret - token.length - 1,
      end: tokenBounds(context.value, context.caret).end,
      query: token,
      ...(directory ? { directory } : {}),
    };
  },

  complete(query: CompletionQuery, context: CompletionContext): CompletionItem[] {
    const items: CompletionItem[] = [];
    const needle = query.query.toLowerCase();
    for (const agent of context.agents) {
      if (!agent.name.toLowerCase().includes(needle)) continue;
      const token = `@${agent.name}`;
      items.push({
        id: `mention:agent:${agent.name}`,
        kind: "subagent",
        label: token,
        description: agent.description,
        detail: agent.source,
        group: "agents",
        insertText: `${token}${context.value.slice(context.caret).startsWith(" ") ? "" : " "}`,
        payload: { kind: "mention", name: agent.name, token },
      });
    }
    const directory = query.directory;
    if (!directory) return items;
    const group = "files";
    const prefix = directory.prefix.toLowerCase();
    const entries = context.entries
      .filter((entry) => entry.name.toLowerCase().startsWith(prefix))
      .sort(compareEntries);
    for (const entry of entries) {
      items.push({
        id: `mention:path:${entry.path}`,
        kind: entry.isDir ? "directory" : "file",
        label: entry.name + (entry.isDir ? "/" : ""),
        description: entry.path,
        group,
        // Accepting a path here drops the token and fills the composer's reference chips instead.
        insertText: "",
        payload: { kind: "reference", reference: { path: entry.path, name: entry.name, isDir: entry.isDir } },
        size: entry.size,
      });
    }
    return items;
  },
};
