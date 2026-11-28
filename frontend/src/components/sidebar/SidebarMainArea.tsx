import { useEffect, useId, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Activity, FileText, Inbox, Plus, Search, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../lib/ui";
import { preloadSettingsContent } from "../settings/settings-loading";
import { useMemorySummary } from "../../lib/memory";
import { WorkspaceSessionList } from "./WorkspaceSessionList";
import { closeSidebarOnNarrow, useNewWorkspaceConversation, useWorkspaceSidebar } from "./workspace-navigation";

export function SidebarMainArea({ cwd, renderSessions }: { cwd: string; renderSessions?: (query: string) => ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const query = useWorkspaceSidebar(state => state.cwd === cwd ? state.query : "");
  const setQuery = useWorkspaceSidebar(state => state.setQuery);
  const settingsOpen = useUiStore(state => state.settingsOpen);
  const newConversation = useNewWorkspaceConversation(cwd);
  const { data: memorySummary } = useMemorySummary(cwd);
  const pendingMemoryCount = Number(memorySummary?.pendingCount) || 0;
  const searchId = useId();
  const root = `/workspace/${encodeURIComponent(cwd)}`;
  const linkClass = "flex h-nav items-center gap-2 rounded-input px-2 text-ui-label text-muted transition-colors hover:bg-surface-hover hover:text-text";

  useEffect(() => {
    if (useWorkspaceSidebar.getState().cwd !== cwd) useWorkspaceSidebar.getState().showConversations(cwd);
  }, [cwd]);

  const routeLink = (to: string, current: boolean, icon: typeof Activity, label: string, count = 0) => {
    const Glyph = icon;
    const accessibleLabel = count ? `${label} (${t("sidebar.pendingKnowledge", { count })})` : label;
    return <Link to={to} aria-label={accessibleLabel} aria-current={current ? "page" : undefined} onClick={closeSidebarOnNarrow} className={`${linkClass} ${current ? "bg-surface-selected font-medium text-accent" : ""}`}><Glyph size={15} /><span className="min-w-0 flex-1 truncate">{label}</span>{count > 0 && <span aria-hidden="true" className="flex min-w-5 items-center justify-center rounded-full bg-accent-fill px-1.5 text-ui-micro text-accent-fg">{count}</span>}</Link>;
  };

  return <section className="flex min-h-0 flex-1 flex-col">
    <button type="button" onClick={() => newConversation()} className="mb-2 flex h-primary shrink-0 items-center justify-center gap-2 rounded-input bg-accent-fill px-3 text-ui-label font-semibold text-accent-fg"><Plus size={16} />{t("conversation.newSession")}</button>
    <nav aria-label={t("shell.primaryNav")} className="mb-2 flex shrink-0 flex-col gap-0.5 border-b border-faint pb-2">
      {routeLink(`${root}/files`, location.pathname === `${root}/files`, FileText, t("nav.files"))}
      {routeLink(`${root}/memory`, location.pathname === `${root}/memory`, Inbox, t("nav.knowledge"), pendingMemoryCount)}
      {routeLink(`${root}/runs`, location.pathname === `${root}/runs`, Activity, t("sidebar.runs"))}
    </nav>
    <div className="mb-2 px-1"><span className="text-ui-caption font-semibold text-text">{t("sidebar.conversations")}</span></div>
    <label className="mb-2 flex h-control shrink-0 items-center gap-2 rounded-input border border-transparent bg-surface-2 px-2 text-muted transition-colors focus-within:border-accent/40 focus-within:bg-surface-raised">
      <Search size={15} aria-hidden="true" />
      <input type="search" aria-label={t("sidebar.search")} aria-describedby={searchId} placeholder={t("sidebar.searchPlaceholder")} value={query} onChange={event => setQuery(cwd, event.target.value)} className="min-w-0 flex-1 bg-transparent text-ui-label text-text outline-none placeholder:text-muted" />
    </label>
    <span id={searchId} className="sr-only">{t("sidebar.searchScope")}</span>
    <div className="min-h-0 flex-1 overflow-hidden">{renderSessions ? renderSessions(query) : <WorkspaceSessionList cwd={cwd} query={query} />}</div>
    <button type="button" aria-expanded={settingsOpen} onClick={() => { preloadSettingsContent(); useUiStore.getState().openSettings(cwd); closeSidebarOnNarrow(); }} onPointerEnter={preloadSettingsContent} onFocus={preloadSettingsContent} className={`${linkClass} mt-2 shrink-0 border-t border-faint pt-2`}><Settings size={15} />{t("nav.settings")}</button>
  </section>;
}
