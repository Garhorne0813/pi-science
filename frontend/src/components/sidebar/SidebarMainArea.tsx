import { lazy, Suspense, useEffect, useId, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Activity, FileText, Inbox, MessageSquare, Plus, Search, Settings } from "lucide-react";
import * as Tabs from "@radix-ui/react-tabs";
import { useUiStore } from "../../lib/ui";
import { WorkspaceSessionList } from "./WorkspaceSessionList";
import { useDocumentVisible } from "../../hooks/use-document-visible";
import { preloadSettingsContent } from "../settings/settings-loading";

import { closeSidebarOnNarrow, useNewWorkspaceConversation, useWorkspaceSidebar } from "./workspace-navigation";

const FileBrowser = lazy(() => import("./FileBrowser").then(module => ({ default: module.FileBrowser })));

export function SidebarMainArea({ cwd, renderSessions }: { cwd: string; renderSessions?: (query: string) => ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const contextPanelCollapsed = useUiStore(state => state.contextPanelCollapsed);
  const tab = useWorkspaceSidebar(state => state.cwd === cwd ? state.tab : "sessions");
  const query = useWorkspaceSidebar(state => state.cwd === cwd ? state.query : "");
  const documentVisible = useDocumentVisible();
  const panelOpen = !contextPanelCollapsed;
  const active = panelOpen && tab === "files" && documentVisible;
  const setTab = useWorkspaceSidebar(state => state.setTab);
  const setQuery = useWorkspaceSidebar(state => state.setQuery);
  const [filesVisited, setFilesVisited] = useState(tab === "files");
  const newConversation = useNewWorkspaceConversation(cwd);
  const settingsOpen = useUiStore(state => state.settingsOpen);
  useEffect(() => {
    if (useWorkspaceSidebar.getState().cwd !== cwd) useWorkspaceSidebar.getState().showConversations(cwd);
  }, [cwd]);
  const searchId = useId();
  const tabClass = "flex h-nav w-full items-center gap-2 rounded-input px-2 text-ui-label text-muted transition-colors hover:bg-surface-hover hover:text-text data-[state=active]:bg-surface-selected data-[state=active]:font-medium data-[state=active]:text-accent";
  const linkClass = "flex h-nav items-center gap-2 rounded-input px-2 text-ui-label text-muted transition-colors hover:bg-surface-hover hover:text-text";
  const root = `/workspace/${encodeURIComponent(cwd)}`;
  const routeLink = (to: string, current: boolean, icon: typeof Activity, label: string) => {
    const Glyph = icon;
    return <Link to={to} aria-current={current ? "page" : undefined} onClick={closeSidebarOnNarrow} className={`${linkClass} ${current ? "bg-surface-selected font-medium text-accent" : ""}`}><Glyph size={15} />{label}</Link>;
  };
  return <section className="flex min-h-0 flex-1 flex-col">
    <Tabs.Root value={tab} onValueChange={value => { if (value !== "sessions" && value !== "files") return; if (value === "files") setFilesVisited(true); setTab(cwd, value); }} className="flex min-h-0 flex-1 flex-col">
      <button type="button" onClick={() => newConversation()} className="mb-2 flex h-primary shrink-0 items-center justify-center gap-2 rounded-input bg-accent-fill px-3 text-ui-label font-semibold text-accent-fg"><Plus size={16} />{t("conversation.newSession")}</button>
      <Tabs.List aria-label={t("sidebar.views")} className="flex shrink-0 flex-col gap-0.5">
        <Tabs.Trigger value="sessions" className={tabClass}><MessageSquare size={15} />{t("sidebar.conversations")}</Tabs.Trigger>
        <Tabs.Trigger value="files" className={tabClass}><FileText size={15} />{t("nav.files")}</Tabs.Trigger>
      </Tabs.List>
      <nav aria-label={t("shell.primaryNav")} className="mb-2 flex shrink-0 flex-col gap-0.5 border-b border-faint pb-2">
        {routeLink(`${root}/memory`, location.pathname === `${root}/memory`, Inbox, t("nav.knowledge"))}
        {routeLink(`${root}/runs`, location.pathname === `${root}/runs`, Activity, t("sidebar.runs"))}
      </nav>
      {/* Keep session lifecycle effects mounted across tabs and collapse. */}
      <Tabs.Content value="sessions" forceMount hidden={tab !== "sessions"} className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        <div className="mb-2 px-1"><span className="text-ui-caption font-semibold text-text">{t("sidebar.conversations")}</span></div>
        <label className="mb-2 flex h-control shrink-0 items-center gap-2 rounded-input border border-transparent bg-surface-2 px-2 text-muted transition-colors focus-within:border-accent/40 focus-within:bg-surface-raised">
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label={t("sidebar.search")} aria-describedby={searchId} placeholder={t("sidebar.searchPlaceholder")} value={query} onChange={event => setQuery(cwd, event.target.value)} className="min-w-0 flex-1 bg-transparent text-ui-label text-text outline-none placeholder:text-muted" />
        </label>
        <span id={searchId} className="sr-only">{t("sidebar.searchScope")}</span>
        <div className="min-h-0 flex-1 overflow-hidden">{renderSessions ? renderSessions(query) : <WorkspaceSessionList cwd={cwd} query={query} />}</div>
      </Tabs.Content>
      {/* Preserve expanded folders while active controls background requests. */}
      <Tabs.Content value="files" forceMount hidden={tab !== "files"} className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        <div className="min-h-0 flex-1 overflow-hidden">{filesVisited && <Suspense fallback={<div role="status" className="p-2 text-ui-label text-muted">{t("inspector.loading")}</div>}><FileBrowser cwd={cwd} embedded active={active} /></Suspense>}</div>
        <button type="button" onClick={() => { navigate(`/workspace/${encodeURIComponent(cwd)}/files`); closeSidebarOnNarrow(); }} className="mt-2 h-nav shrink-0 rounded-input px-2 text-left text-ui-label text-muted hover:bg-surface-hover hover:text-text">{t("sidebar.allFiles")} →</button>
      </Tabs.Content>
    </Tabs.Root>
    <button type="button" aria-expanded={settingsOpen} onClick={() => { preloadSettingsContent(); useUiStore.getState().openSettings(cwd); closeSidebarOnNarrow(); }} onPointerEnter={preloadSettingsContent} onFocus={preloadSettingsContent} className={`${linkClass} mt-2 shrink-0 border-t border-faint pt-2`}><Settings size={15} />{t("nav.settings")}</button>
  </section>;
}
