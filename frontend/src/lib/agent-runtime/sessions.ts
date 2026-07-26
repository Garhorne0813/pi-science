/** Session list loading and the optimistic-session bookkeeping it needs. */

import { getClient, getSessionName, type SessionInfo } from "../pi-science-client";
import { useRuntimeStore } from "./store";

/** Sessions created locally that the backend has not listed yet. Owned here
 *  because `loadSessionsInternal` is what merges and retires those entries;
 *  the store actions add on create/fork and drop on delete/remove. */
export const optimisticSessionIds = new Set<string>();

export async function loadSessionsInternal(cwdOverride?: string): Promise<SessionInfo[]> {
  const state = useRuntimeStore.getState();
  const requestedCwd = cwdOverride ?? state.cwd;
  if (cwdOverride && state.cwd !== cwdOverride) {
    useRuntimeStore.setState({ cwd: cwdOverride, sessions: [], activeSessionId: null });
  }
  try {
    const client = getClient();
    const fromDisk = await client.listSessions(requestedCwd);
    const current = useRuntimeStore.getState();
    if (current.cwd !== requestedCwd) return [];
    // Inject names from localStorage
    const named = fromDisk.map((s: SessionInfo) => ({
      ...s,
      name: s.name || getSessionName(requestedCwd, s.id) || undefined,
    }));
    // Preserve only the active, newly-created optimistic entry. Treating every
    // disk-missing item as optimistic resurrects sessions after deletion.
    const diskIds = new Set(named.map((s: SessionInfo) => s.id));
    for (const id of diskIds) optimisticSessionIds.delete(id);
    const optimistic = current.sessions.filter((session: SessionInfo) => (
      optimisticSessionIds.has(session.id) && !diskIds.has(session.id)
    ));
    const merged = [...optimistic, ...named];
    useRuntimeStore.setState({ sessions: merged.slice(0, 50) });
    return merged.slice(0, 50);
  } catch (err) {
    console.error("Failed to load sessions:", err);
    return [];
  }
}
