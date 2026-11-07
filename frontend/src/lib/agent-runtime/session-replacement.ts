/** Adopt a backend-issued replacement session id (runtime restart, settings
 *  change) without losing the conversation's name, list entry or route. */

import {
  clearAiTitle,
  clearCachedMessages,
  clearSessionName,
  getClient,
  getSessionName,
  moveSessionName,
  type SessionInfo,
} from "../client/pi-science-client";
import { useMessageQuoteStore } from "../conversation/message-quote";
import { replaceBrowserSessionRoute } from "./session-navigation";
import { emptyThread, resetTurnBuffer } from "./folding/state";
import { generations, turnState } from "./generations";
import { resyncCompletedHistory } from "./recovery/settled-history";
import { loadSessionsInternal } from "./sessions";
import { runtimeStore } from "./store-access";
import type { SessionReplacement } from "./types";

export function applySessionReplacements(replacements: SessionReplacement[]): string | null {
  const state = runtimeStore.getState();
  const relevant = replacements.filter((replacement) => (
    replacement.cwd === state.cwd
    && replacement.oldId
    && replacement.newId
    && replacement.oldId !== replacement.newId
  ));
  if (relevant.length === 0) return state.activeSessionId;

  const replacementById = new Map(relevant.map((item) => [item.oldId, item.newId]));
  const resolveId = (initialId: string): string => {
    let id = initialId;
    const visited = new Set<string>();
    while (replacementById.has(id) && !visited.has(id)) {
      visited.add(id);
      id = replacementById.get(id)!;
    }
    return id;
  };

  for (const replacement of relevant) {
    moveSessionName(state.cwd, replacement.oldId, resolveId(replacement.oldId));
    // A pending quote is filed by session id. Re-issuing an id for the same
    // conversation must carry the quote along, or it disappears mid-conversation.
    useMessageQuoteStore.getState().migrateSession({ workspaceCwd: state.cwd, sessionId: replacement.oldId }, resolveId(replacement.oldId));
    // The old session id is gone — drop its message cache and SSE cursor so
    // they can't resurface or cause a stale resume on a reused id.
    clearCachedMessages(state.cwd, replacement.oldId);
    getClient().clearCursor(state.cwd, replacement.oldId);
    clearSessionName(state.cwd, replacement.oldId);
    clearAiTitle(state.cwd, replacement.oldId);
  }

  const sessionsById = new Map<string, SessionInfo>();
  for (const session of state.sessions) {
    const nextId = resolveId(session.id);
    const storedName = getSessionName(state.cwd, nextId);
    const next = {
      ...session,
      id: nextId,
      name: storedName || session.name,
    };
    const existing = sessionsById.get(nextId);
    sessionsById.set(nextId, existing ? { ...next, ...existing, name: existing.name || next.name } : next);
  }

  const previousActiveId = state.activeSessionId;
  const nextActiveId = previousActiveId ? resolveId(previousActiveId) : null;
  if (previousActiveId && nextActiveId && previousActiveId !== nextActiveId && !sessionsById.has(nextActiveId)) {
    sessionsById.set(nextActiveId, {
      id: nextActiveId,
      cwd: state.cwd,
      name: getSessionName(state.cwd, nextActiveId) || undefined,
    });
  }
  runtimeStore.setState({ sessions: [...sessionsById.values()], activeSessionId: nextActiveId });
  if (!previousActiveId || !nextActiveId || previousActiveId === nextActiveId) return nextActiveId;

  ++generations.connection;
  ++generations.activity;
  ++generations.localMutation;
  resetTurnBuffer();
  turnState.errored = false;
  const client = getClient();
  client.connect(nextActiveId, state.cwd);
  runtimeStore.setState({
    client,
    thread: emptyThread(),
    working: false,
    turnLifecycle: "settled",
    status: "connecting",
    pendingInteraction: null,
    pendingQuestionnaire: null,
  });

  replaceBrowserSessionRoute(previousActiveId, nextActiveId);
  void resyncCompletedHistory(nextActiveId, state.cwd);
  void loadSessionsInternal();
  return nextActiveId;
}
