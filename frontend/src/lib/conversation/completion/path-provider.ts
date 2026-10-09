import { tokenBounds } from "./token";
import type { CompletionContext, CompletionDirectory, CompletionEntry, CompletionItem, CompletionProvider, CompletionQuery } from "./types";

export function splitPathToken(token: string): CompletionDirectory | null {
  if (!token) return null;
  if (token.startsWith("/")) return null;
  if (token.includes("@")) return null;
  const slash = token.lastIndexOf("/");
  const directory = slash === -1 ? "" : token.slice(0, slash);
  if (directory.split("/").includes("..")) return null;
  const stripped = directory.startsWith("./") ? directory.slice(2) : directory;
  const subdir = stripped === "." ? "" : stripped;
  return {
    subdir,
    prefix: slash === -1 ? token : token.slice(slash + 1),
    base: slash === -1 ? "" : token.slice(0, slash + 1),
  };
}

/** Directories first, then files; inside each group a case-insensitive name order. */
export function compareEntries(a: CompletionEntry, b: CompletionEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export const pathProvider: CompletionProvider = {
  id: "path",

  detect(context: CompletionContext): CompletionQuery | null {
    const bounds = tokenBounds(context.value, context.caret);
    const directory = splitPathToken(context.value.slice(bounds.start, context.caret));
    if (!directory) return null;
    const writesIntoDirectory = Boolean(directory.base);
    return { providerId: "path", kind: "directory", start: bounds.start, end: bounds.end, query: context.value.slice(bounds.start, context.caret), directory, autoOpen: writesIntoDirectory };
  },

  complete(query: CompletionQuery, context: CompletionContext): CompletionItem[] {
    const directory = query.directory;
    if (!directory) return [];
    const prefix = directory.prefix.toLowerCase();
    return [...context.entries]
      .filter((entry) => entry.name.toLowerCase().startsWith(prefix))
      .sort(compareEntries)
      .map((entry) => ({
        id: `path:${entry.path}`,
        kind: entry.isDir ? "directory" : "file",
        label: entry.name + (entry.isDir ? "/" : ""),
        insertText: directory.base + entry.name + (entry.isDir ? "/" : ""),
        size: entry.size,
        description: entry.path === entry.name ? undefined : entry.path,
      }));
  },
};
