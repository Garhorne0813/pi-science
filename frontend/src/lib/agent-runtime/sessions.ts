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
const loadMorePromises = new Map<string, Promise<number>>();

function withLocalNames(fromDisk: SessionInfo[], current: ReturnType<typeof useRuntimeStore.getState>, cwd: string): SessionInfo[] {
  return fromDisk.map((session) => ({
    ...session,
    name: session.name || current.sessions.find((item) => item.id === session.id)?.name || getSessionName(cwd, session.id) || undefined,
  }));
}

export async function loadSessionsInternal(cwdOverride?: string): Promise<SessionInfo[]> {
  const state = useRuntimeStore.getState();
  const requestedCwd = cwdOverride ?? state.cwd;
  const requestVersion = ++sessionsListVersion;
  if (cwdOverride && state.cwd !== cwdOverride) {
    useRuntimeStore.setState({ cwd: cwdOverride, sessions: [], sessionsCursor: null, sessionsHasMore: false, sessionsLoading: false, activeSessionId: null });
  }
  useRuntimeStore.setState({ sessionsLoading: true });
  try {
    const client = getClient();
    const page = await client.listSessionsPage(requestedCwd, { limit: 30 });
    const current = useRuntimeStore.getState();
    if (current.cwd !== requestedCwd) return [];
    if (requestVersion !== sessionsListVersion) {
      // A newer load superseded this one. Never overwrite the fresher list,
      // but return the current authoritative list (callers like ProjectsLayout
      // drive auto-navigation from the returned sessions).
      return current.sessions;
    }
    // Inject names from localStorage
    const named = withLocalNames(page.sessions, current, requestedCwd);
    // Preserve only the active, newly-created optimistic entry. Treating every
    // disk-missing item as optimistic resurrects sessions after deletion.
    const diskIds = new Set(named.map((s: SessionInfo) => s.id));
    for (const id of diskIds) optimisticSessionIds.delete(id);
    const optimistic = current.sessions.filter((session: SessionInfo) => (
      optimisticSessionIds.has(session.id) && !diskIds.has(session.id)
    ));
    const currentActive = current.sessions.find((session) => session.id === current.activeSessionId);
    const activeFallback = current.activeSessionId
      && !named.some((session) => session.id === current.activeSessionId)
      && !optimistic.some((session) => session.id === current.activeSessionId)
      ? [{
          ...currentActive,
          id: current.activeSessionId,
          cwd: requestedCwd,
          name: currentActive?.name || getSessionName(requestedCwd, current.activeSessionId) || undefined,
        }]
      : [];
    const merged = [...activeFallback, ...optimistic, ...named];
    useRuntimeStore.setState({ sessions: merged, sessionsCursor: page.next_cursor, sessionsHasMore: page.has_more, sessionsLoading: false });
    return merged;
  } catch (err) {
    console.error("Failed to load sessions:", err);
    if (useRuntimeStore.getState().cwd === requestedCwd) useRuntimeStore.setState({ sessionsLoading: false });
    return [];
  }
}

export async function loadMoreSessionsInternal(): Promise<number> {
  const initial = useRuntimeStore.getState();
  if (!initial.sessionsHasMore || !initial.sessionsCursor) return 0;
  const cwd = initial.cwd;
  const cursor = initial.sessionsCursor;
  const key = `${cwd}\u0000${cursor}`;
  const existingPromise = loadMorePromises.get(key);
  if (existingPromise) return existingPromise;
  if (initial.sessionsLoading) return 0;
  const version = sessionsListVersion;
  useRuntimeStore.setState({ sessionsLoading: true });
  const promise = (async () => {
    try {
      const page = await getClient().listSessionsPage(cwd, { cursor, limit: 30 });
      const current = useRuntimeStore.getState();
      if (current.cwd !== cwd || current.sessionsCursor !== cursor || sessionsListVersion !== version) return 0;
      const named = withLocalNames(page.sessions, current, cwd);
      // Replace a synthetic active fallback with its authoritative metadata
      // when the corresponding page eventually reaches it, restoring the
      // server's chronological position instead of leaving it pinned on top.
      const pageIds = new Set(named.map((session) => session.id));
      const existing = current.sessions.filter((session) => !pageIds.has(session.id));
      const existingIds = new Set(existing.map((session) => session.id));
      const fresh = named.filter((session) => !existingIds.has(session.id));
      useRuntimeStore.setState({
        sessions: [...existing, ...fresh],
        sessionsCursor: page.next_cursor,
        sessionsHasMore: page.has_more,
        sessionsLoading: false,
      });
      return fresh.length;
    } catch (error) {
      console.error("Failed to load more sessions:", error);
      if (useRuntimeStore.getState().cwd === cwd) useRuntimeStore.setState({ sessionsLoading: false });
      return 0;
    } finally {
      loadMorePromises.delete(key);
    }
  })();
  loadMorePromises.set(key, promise);
  return promise;
}
