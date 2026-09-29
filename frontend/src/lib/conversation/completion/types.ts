import type { SlashCommand } from "../slash-commands";

/** One candidate list, one keyboard handler, one menu. Every provider below answers the
 *  same question: "the caret is here, what could go next?". */

export type CompletionKind = "command" | "argument" | "subagent" | "file" | "directory";

/** A named run of rows in one candidate list. The menu turns it into a heading, so a provider
 *  names a group instead of translating one. */
export type CompletionGroup = "agents" | "files";

/** The fields the completion layer reads from a workspace directory listing. `FileListEntry`
 *  is structurally compatible, so no mapping code sits between the API and the providers. */
export interface CompletionEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export interface CompletionAgent {
  name: string;
  description?: string;
  source?: string;
}

/** A candidate row. `insertText` replaces `[query.start, query.end)`; an empty string deletes
 *  the span, which is how a `@file` mention turns into a reference chip. */
export interface CompletionItem {
  /** Natural key, unique inside one list: "command:export", "file:data/a.csv". */
  id: string;
  kind: CompletionKind;
  /** Menu row text, exactly what the user reads. */
  label: string;
  /** Secondary line, used as the row title attribute. */
  description?: string;
  /** Right-aligned text: the argument hint of a command, the byte size of a file. */
  detail?: string;
  /** Heading this row sits under. Rows keep provider order inside a group. */
  group?: CompletionGroup;
  insertText: string;
  /** Present when accepting also fills a structured composer slot, such as a workspace
   *  reference or a highlighted subagent mention. */
  payload?: CompletionPayload;
  /** Source byte size of a file or directory entry, formatted by the menu. */
  size?: number;
}

/** A structured slot an accepted candidate fills. The composer owns both slots; the provider
 *  only names which one the candidate belongs to. */
export type CompletionPayload =
  | { kind: "reference"; reference: CompletionReference }
  | { kind: "mention"; name: string; token: string };

/** The workspace-relative identity of a file or directory. The composer adds the workspace. */
export interface CompletionReference {
  path: string;
  name: string;
  isDir: boolean;
}

/** What one provider claims about the caret. `start`/`end` bracket the whole token under the caret,
 *  so `insertText` replaces the token even when the caret sits in the middle of it. */
export interface CompletionQuery {
  providerId: string;
  kind: CompletionKind;
  start: number;
  end: number;
  /** The owned token, without its trigger character. It reaches only to the caret, so it is the
   *  part the user has typed even when `end` runs past it. */
  query: string;
  /** Set when the answer lives in one workspace directory listing. The composer loads that
   *  directory before it calls `complete`, and `CompletionContext.entries` then holds it. */
  directory?: CompletionDirectory;
  /** Set when the answer depends on which command argument the caret is in. */
  argument?: { command: string; index: number };
}

/** A workspace-relative path split at the caret: list `subdir`, keep `base`, match `prefix`. */
export interface CompletionDirectory {
  subdir: string;
  prefix: string;
  /** The text before `prefix` that an accepted path has to keep, such as "data/" or "./data/". */
  base: string;
}

/** Everything a provider may read besides the query it produced. */
export interface CompletionContext {
  value: string;
  caret: number;
  cwd: string;
  /** Entries of `query.directory.subdir`, or empty while that listing loads or after it fails. */
  entries: readonly CompletionEntry[];
  /** Subagents discovered for `cwd`, or empty while discovery runs or after it fails. */
  agents: readonly CompletionAgent[];
  /** Commands the composer may run: the builtins plus the discovered `skill:*` commands. */
  commands: readonly SlashCommand[];
}

export interface CompletionProvider {
  id: string;
  /** How the list becomes visible. A "typing" provider shows candidates while the user types,
   *  so Tab and Enter both accept the active row. A "tab" provider stays hidden until the user
   *  asks for it, so Tab first fills in the common prefix and only then opens the list. */
  trigger: "typing" | "tab";
  /** The query this provider owns at the caret, or null when it owns nothing. Must be pure and
   *  must not read `CompletionContext.entries` or `CompletionContext.agents`: the loader asks a
   *  provider first, then loads what that provider said it needs. */
  detect(context: CompletionContext): CompletionQuery | null;
  /** Candidates for a query this provider produced. Empty means no completion exists, and the
   *  composer leaves the key to the browser. */
  complete(query: CompletionQuery, context: CompletionContext): CompletionItem[];
}

/** What one key press should do. `ignore` hands the key back to the browser and the composer. */
export type CompletionCommand =
  | { kind: "ignore" }
  | { kind: "open-menu" }
  | { kind: "apply"; value: string; caret: number; start: number; end: number; payload?: CompletionPayload };

/** The apply branch, named for the composer that carries it out. */
export type CompletionApply = Extract<CompletionCommand, { kind: "apply" }>;
