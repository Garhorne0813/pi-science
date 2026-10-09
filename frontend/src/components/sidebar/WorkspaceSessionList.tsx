import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { GitFork, MoreHorizontal, Trash2 } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTranslation } from "react-i18next";
import type { SessionInfo } from "../../lib/client/types";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { cn, useUiStore } from "../../lib/ui";
import { useFeedback } from "../feedback/feedback-context";
import { closeSidebarOnNarrow } from "./workspace-navigation";

export function groupSessions(sessions: SessionInfo[], query: string, now = new Date(), newTitle = "New Session") {
  const normalized = query.trim().toLocaleLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - 7);
  const groups = ["today", "yesterday", "week", "earlier"].map(key => ({ key, sessions: [] as SessionInfo[] }));
  for (const session of sessions) {
    const title = session.name === "New Session" ? newTitle : session.name || session.id.slice(0, 8);
    if (normalized && !title.toLocaleLowerCase().includes(normalized)) continue;
    const raw = session.updated_at || session.created_at;
    const timestamp = raw ? new Date(raw).getTime() : NaN;
    const index = !Number.isFinite(timestamp) ? 3 : timestamp >= +today ? 0 : timestamp >= +yesterday ? 1 : timestamp >= +week ? 2 : 3;
    groups[index].sessions.push(session);
  }
  return groups.filter(group => group.sessions.length > 0);
}

export function WorkspaceSessionList({ cwd, query = "" }: { cwd: string; query?: string }) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const sessions = useRuntimeStore((s) => s.sessions);
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const forkSession = useRuntimeStore((s) => s.forkSession);
  const loadSessions = useRuntimeStore((s) => s.loadSessions);
  const loadMoreSessions = useRuntimeStore((s) => s.loadMoreSessions);
  const sessionsHasMore = useRuntimeStore((s) => s.sessionsHasMore);
  const sessionsLoading = useRuntimeStore((s) => s.sessionsLoading);
  const deleteSession = useRuntimeStore((s) => s.deleteSession);
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceRoot = `/workspace/${encodeURIComponent(cwd)}`;
  const isWorkspaceRoot = location.pathname === workspaceRoot;
  // The store marker carries the suppression across a layout remount; the
  // route-state target prevents a fast workspace switch from consuming it in
  // the wrong workspace.
  const intentionalRootLanding = location.state?.suppressAutoSessionNavFor === cwd;
  const [deleting, setDeleting] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Load metadata for a direct conversation link when the store starts
    // empty. Do not reload the list for files, runs, settings, or a session
    // route that already has session metadata.
    const isConversationRoute = location.pathname.startsWith(`${workspaceRoot}/session/`);
    if (!isWorkspaceRoot && (!isConversationRoute || sessions.length > 0)) return () => { cancelled = true; };

    // Consume suppression only for the intentional root landing that set it.
    // A stale marker from an interrupted/other-workspace navigation is cleared,
    // but a normal first root entry still loads and may auto-open a session.
    const suppressAutoNav = useUiStore.getState().suppressAutoSessionNav;
    if (suppressAutoNav && intentionalRootLanding) {
      useUiStore.getState().setSuppressAutoSessionNav(false);
      return () => { cancelled = true; };
    }
    if (suppressAutoNav) useUiStore.getState().setSuppressAutoSessionNav(false);

    loadSessions(cwd)
      .then((merged) => {
        if (cancelled) return;
        // Auto-load most recent session if none active
        const state = useRuntimeStore.getState();
        if (isWorkspaceRoot && merged.length > 0 && !state.activeSessionId) {
          const latest = merged[0];
          navigate(`/workspace/${encodeURIComponent(cwd)}/session/${latest.id}`);
        }
      })
      .catch((error) => {
        if (!cancelled) toast(error instanceof Error ? error.message : t("sidebar.loadError"), "error");
      });
    return () => { cancelled = true; };
  }, [cwd, intentionalRootLanding, isWorkspaceRoot, loadSessions, location.pathname, navigate, sessions.length, t, toast, workspaceRoot]);

  const handleDelete = async (e: { stopPropagation(): void }, sessionId: string) => {
    e.stopPropagation();
    if (deleting || forking) return;
    setDeleting(sessionId);
    // Read freshness after the await: the user may have switched sessions
    // while the delete was in flight, and we must not kick them out of the
    // session they are now viewing.
    const wasActive = useRuntimeStore.getState().activeSessionId === sessionId;
    try {
      await deleteSession(sessionId);
      // Only the active-session delete lands on the blank workspace, and only
      // when the store agrees the session is really gone (deleteSession
      // detaches the stream and clears activeSessionId). The user could have
      // opened another session meanwhile, or switched workspaces.
      const state = useRuntimeStore.getState();
      if (wasActive && state.activeSessionId === null && state.cwd === cwd) {
        // deleteSession already detached the stream and blanked the thread.
        // Return to the workspace landing (blank composer) instead of creating
        // a fresh session — the first prompt creates one lazily. Set a flag so
        // the session-list auto-nav effect does not yank the user straight
        // back into the most recent session. replace: true keeps the landing
        // as the entry point instead of stacking history entries.
        useUiStore.getState().setSuppressAutoSessionNav(true);
        navigate(workspaceRoot, { replace: true, state: { suppressAutoSessionNavFor: cwd } });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : t("sidebar.deleteError"), "error");
    } finally {
      setDeleting(null);
    }
  };

  const handleFork = async (e: { stopPropagation(): void }, sessionId: string) => {
    e.stopPropagation();
    if (forking || deleting) return;
    setForking(sessionId);
    try {
      const newId = await forkSession(sessionId);
      navigate(`${workspaceRoot}/session/${newId}`);
      closeSidebarOnNarrow();
    } catch (error) {
      toast(error instanceof Error ? error.message : t("sidebar.forkError"), "error");
    } finally {
      setForking(null);
    }
  };

  const groups = useMemo(() => groupSessions(sessions, query, new Date(), t("conversation.newSession")), [sessions, query, t]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" aria-label={t("sidebar.sessionList")}>
        {groups.length === 0 && <p className="px-2 py-2 text-ui-meta text-muted">{t(query.trim() ? "sidebar.noMatches" : "conversation.noSessions")}</p>}
        {groups.map(group => <section key={group.key} className="mb-2">
          <h2 className="px-2 py-1 text-ui-caption font-medium text-muted">{t(`sidebar.${group.key}`)}</h2>
          {group.sessions.map(session => {
            const active = activeSessionId === session.id;
            const label = session.name === "New Session" ? t("conversation.newSession") : session.name || session.id.slice(0, 8);
            return <div key={session.id} className={cn("group relative flex min-w-0 items-center rounded-input hover:bg-surface-hover focus-within:bg-surface-hover", active && "bg-surface-selected")}>
              <button type="button" title={label} aria-current={active ? "page" : undefined}
                onClick={() => { navigate(`${workspaceRoot}/session/${session.id}`); closeSidebarOnNarrow(); }}
                className={cn("flex h-nav min-w-0 flex-1 items-center gap-2 px-2 text-left text-ui-label", active && "font-medium")}>
                <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", active ? "bg-accent" : "bg-transparent")} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button type="button" aria-label={t("sidebar.manageSession", { name: label })} disabled={!!deleting || !!forking}
                    className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-input text-muted opacity-0 hover:bg-surface-2 hover:text-text group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 disabled:opacity-60">
                    <MoreHorizontal size={16} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8} className="ui-popover z-[110] min-w-40 rounded-card p-1 text-ui-label text-text shadow-lg">
                    <DropdownMenu.Item onSelect={(e) => void handleFork(e, session.id)} className="flex h-nav cursor-default select-none items-center gap-2 rounded-input px-2 outline-none data-[highlighted]:bg-surface-hover"><GitFork size={14} />{t("sidebar.forkSession")}</DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={(e) => void handleDelete(e, session.id)} className="flex h-nav cursor-default select-none items-center gap-2 rounded-input px-2 text-error-text outline-none data-[highlighted]:bg-surface-hover"><Trash2 size={14} />{t("sidebar.deleteSession")}</DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>;
          })}
        </section>)}
        {sessionsHasMore && <button type="button" disabled={sessionsLoading} onClick={() => void loadMoreSessions().catch(error => toast(error instanceof Error ? error.message : t("sidebar.loadError"), "error"))} className="mx-2 mb-2 rounded-input px-2 py-2 text-ui-meta text-muted hover:bg-surface-hover disabled:opacity-60">{t(sessionsLoading ? "conversation.loadingSessions" : "conversation.loadMoreSessions")}</button>}
        {query.trim() && sessionsHasMore && <p className="px-2 pb-2 text-ui-micro text-muted">{t("sidebar.searchScope")}</p>}
      </div>
    </div>
  );
}
