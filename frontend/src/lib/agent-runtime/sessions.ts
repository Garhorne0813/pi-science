/** Session list loading and the optimistic-session bookkeeping it needs. */

import { getClient, getSessionName, type SessionInfo } from "../client/pi-science-client";
import { useRuntimeStore } from "./store";

/** Sessions created locally that the backend has not listed yet. Owned here
 *  because `loadSessionsInternal` is what merges and retires those entries;
 *  the store actions add on create/fork and drop on delete/remove. */
export const optimisticSessionIds = new Set<string>();

/** Monotonic request counter so a stale in-flight list cannot overwrite a
 *  fresher one that resolved later (slow first request vs fast second). */
let sessionsListVersion = 0;

export async function loadSessionsInternal(cwdOverride?: string): Promise<SessionInfo[]> {
  const state = useRuntimeStore.getState();
  const requestedCwd = cwdOverride ?? state.cwd;
  const requestVersion = ++sessionsListVersion;
  if (cwdOverride && state.cwd !== cwdOverride) {
    useRuntimeStore.setState({ cwd: cwdOverride, sessions: [], activeSessionId: null });
  }
  try {
    const client = getClient();
    const fromDisk = await client.listSessions(requestedCwd);
    const current = useRuntimeStore.getState();
    if (current.cwd !== requestedCwd) return [];
    if (requestVersion !== sessionsListVersion) {
      // A newer load superseded this one. Never overwrite the fresher list,
      // but return the current authoritative list (callers like ProjectsLayout
      // drive auto-navigation from the returned sessions).
      return current.sessions.slice(0, 50);
    }
    // Inject names from localStorage
    const named = fromDisk.map((s: SessionInfo) => ({
      ...s,
      name: s.name || current.sessions.find((item) => item.id === s.id)?.name || getSessionName(requestedCwd, s.id) || undefined,
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
