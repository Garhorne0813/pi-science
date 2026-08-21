/** Session display naming: derive a name from the conversation and keep the
 *  sidebar entry in sync with the stored one. */

import type { ThreadBlock } from "../../types/thread";
import { deriveSessionName, getSessionName, markDerivedSessionName, setLocalSessionName } from "../client/pi-science-client";
import { clearAiTitleAttempted, clearDerivedSessionName, hasAiTitle, hasDerivedSessionName, markAiTitle } from "../client/session-names";
import { visibleUserMessage } from "../files";
import type { Thread } from "./event-fold";
import { useRuntimeStore } from "./store";

const PLACEHOLDER_SESSION_NAME = "New Session";

function existingSessionName(cwd: string, sessionId: string): string {
  const localName = getSessionName(cwd, sessionId);
  if (localName) return localName;
  const session = useRuntimeStore.getState().sessions.find((item) => item.id === sessionId);
  return session?.name && session.name !== PLACEHOLDER_SESSION_NAME ? session.name : "";
}

/** Backfill a display name from the first user block of freshly loaded
 *  history. Sessions created before client-side naming existed (or whose
 *  localStorage entry is missing) would otherwise show raw ids in the sidebar
 *  forever. Never overwrites a stored or server-provided name and no-ops on
 *  empty threads. */
export function backfillSessionName(cwd: string, sessionId: string, thread: Thread): void {
  if (existingSessionName(cwd, sessionId)) return;
  const firstUser = thread.blocks.find(
    (block): block is Extract<ThreadBlock, { kind: "user" }> => block.kind === "user",
  );
  const name = firstUser ? deriveSessionName(visibleUserMessage(firstUser.text)) : "";
  if (!name) return;
  setLocalSessionName(cwd, sessionId, name);
  markDerivedSessionName(cwd, sessionId);
  useRuntimeStore.setState((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, name } : session),
  }));
}

/** Use the first user message as the session name. A message that is only
 *  file references still gets a stable fallback label. */
export function applyPromptSessionName(cwd: string, sessionId: string, message: string): void {
  if (existingSessionName(cwd, sessionId)) return;
  const sessionName = deriveSessionName(visibleUserMessage(message)) || "Referenced files";
  setLocalSessionName(cwd, sessionId, sessionName);
  markDerivedSessionName(cwd, sessionId);
  useRuntimeStore.setState((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, name: sessionName } : session),
  }));
}

/** Apply an AI-generated title over a temporary display name and mark it as
 *  AI so later settle events do not regenerate it. Re-checks both the local
 *  marker and the current session metadata: a server title loaded while the
 *  AI request was in flight must win over the late AI result. The server POST
 *  already persisted the accepted title, so this path writes only locally and
 *  cannot issue a stale asynchronous PUT. */
export function applyAiSessionName(cwd: string, sessionId: string, title: string): void {
  if (hasAiTitle(cwd, sessionId)) return;
  const localName = getSessionName(cwd, sessionId);
  const currentSession = useRuntimeStore.getState().sessions.find((session) => session.id === sessionId);
  const currentName = currentSession?.name && currentSession.name !== PLACEHOLDER_SESSION_NAME ? currentSession.name : "";
  const derived = hasDerivedSessionName(cwd, sessionId);
  if ((localName && !derived) || (currentName && currentName !== localName)) return;
  clearDerivedSessionName(cwd, sessionId);
  setLocalSessionName(cwd, sessionId, title);
  markAiTitle(cwd, sessionId);
  clearAiTitleAttempted(cwd, sessionId);
  useRuntimeStore.setState((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, name: title } : session),
  }));
}
