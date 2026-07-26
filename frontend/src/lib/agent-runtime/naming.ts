/** Session display naming: derive a name from the conversation and keep the
 *  sidebar entry in sync with the stored one. */

import type { ThreadBlock } from "../../types/thread";
import { deriveSessionName, getSessionName, setSessionName } from "../pi-science-client";
import { visibleUserMessage } from "../file-references";
import type { Thread } from "./event-fold";
import { useRuntimeStore } from "./store";

/** Backfill a display name from the first user block of freshly loaded
 *  history. Sessions created before client-side naming existed (or whose
 *  localStorage entry is missing) would otherwise show raw ids in the sidebar
 *  forever. Never overwrites a stored name and no-ops on empty threads. */
export function backfillSessionName(cwd: string, sessionId: string, thread: Thread): void {
  if (getSessionName(cwd, sessionId)) return;
  const firstUser = thread.blocks.find(
    (block): block is Extract<ThreadBlock, { kind: "user" }> => block.kind === "user",
  );
  const name = firstUser ? deriveSessionName(visibleUserMessage(firstUser.text)) : "";
  if (!name) return;
  setSessionName(cwd, sessionId, name);
  useRuntimeStore.setState((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, name } : session),
  }));
}

/** Use the first user message as the session name. A message that is only
 *  file references still gets a stable fallback label. */
export function applyPromptSessionName(cwd: string, sessionId: string, message: string): void {
  if (getSessionName(cwd, sessionId)) return;
  const sessionName = deriveSessionName(visibleUserMessage(message)) || "Referenced files";
  setSessionName(cwd, sessionId, sessionName);
  useRuntimeStore.setState((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, name: sessionName } : session),
  }));
}
