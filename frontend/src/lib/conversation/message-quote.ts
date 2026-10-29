/** Message quotes. A quote is a value, not a reference: it copies the text the
 *  user quoted, so the model can read it without any server lookup. Source ids
 *  exist only so the UI can navigate back. */

import { create } from "zustand";
// The store handle, not the barrel: session replacement reads this module, and
// reaching it through the barrel would close an import cycle.
import { useRuntimeStore } from "../agent-runtime/store";

export interface MessageQuoteScope { workspaceCwd: string; sessionId: string; }
export type MessageQuoteRole = "user" | "agent";
export interface MessageQuoteSource extends MessageQuoteScope { blockId: string; role: MessageQuoteRole; }
export type MessageQuoteKind = "message" | "selection";
export interface MessageQuote {
  source: MessageQuoteSource;
  kind: MessageQuoteKind;
  /** Verbatim quoted content. Trimming decides only whether anything was
   *  selected, because a lost indent changes what code means. */
  text: string;
  /** Whole source message at quote time, so a fragment is never passed off as the full message. */
  messageText: string;
}

function quoteKey(scope: MessageQuoteScope): string {
  return `${scope.workspaceCwd}\u0000${scope.sessionId}`;
}

export function buildMessageQuote(input: { source: MessageQuoteSource; messageText: string; selection?: string | null }): MessageQuote | null {
  const { messageText } = input;
  if (!messageText.trim()) return null;
  const selection = input.selection ?? "";
  // Selecting the whole message is a whole-message quote, not a fragment.
  const quoted = selection.trim() && selection.trim() !== messageText.trim() ? selection : "";
  return {
    source: input.source,
    kind: quoted ? "selection" : "message",
    text: quoted || messageText,
    messageText,
  };
}

/** Rendered text is not markdown source text: a selection inside `**bold**` yields
 *  `bold`, so a selection must never be matched against the source with includes().
 *  A range touching `data-quote-exclude` is refused, because run output is
 *  produced after the message was written and is absent from `messageText`;
 *  filing it would claim the message said something it never said. */
export function selectedTextWithin(element: HTMLElement): string | null {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const touchesExcluded = Array.from(element.querySelectorAll("[data-quote-exclude]")).some((excluded) => range.intersectsNode(excluded));
  if (touchesExcluded) return null;
  const text = range.toString();
  return text.trim() ? text : null;
}

export interface MessageQuoteState {
  quotes: Record<string, MessageQuote>;
  setQuote: (quote: MessageQuote) => void;
  migrateSession: (scope: MessageQuoteScope, newSessionId: string) => void;
}

/** One pending quote per conversation. The key comes from the quote itself, so a
 *  quote can never be filed under a conversation other than its source. */
export const useMessageQuoteStore = create<MessageQuoteState>((set) => ({
  quotes: {},
  setQuote: (quote) => set((state) => ({ quotes: { ...state.quotes, [quoteKey(quote.source)]: quote } })),
  // A runtime restart re-issues the session id for a conversation the user never
  // left. Without this the key misses and the pending quote disappears as if
  // they had walked away, which the isolation rule does not ask for.
  migrateSession: (scope, newSessionId) => set((state) => {
    const from = quoteKey(scope);
    const quote = state.quotes[from];
    if (scope.sessionId === newSessionId || !quote) return state;
    const quotes = { ...state.quotes };
    delete quotes[from];
    const moved: MessageQuote = { ...quote, source: { ...quote.source, sessionId: newSessionId } };
    quotes[quoteKey(moved.source)] = moved;
    return { quotes };
  }),
}));

/** The active quote is whatever is filed under the conversation the runtime shows.
 *  Switching conversation needs no cleanup: the lookup simply misses. */
export function useActiveMessageQuote(): MessageQuote | null {
  const cwd = useRuntimeStore((state) => state.cwd);
  const sessionId = useRuntimeStore((state) => state.activeSessionId);
  const quotes = useMessageQuoteStore((state) => state.quotes);
  return sessionId ? quotes[quoteKey({ workspaceCwd: cwd, sessionId })] ?? null : null;
}
