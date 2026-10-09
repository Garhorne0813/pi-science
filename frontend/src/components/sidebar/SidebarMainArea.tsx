import { lazy, Suspense, useEffect, useId, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FileText, MessageSquare, Plus, Search } from "lucide-react";
import * as Tabs from "@radix-ui/react-tabs";
import { useUiStore } from "../../lib/ui";
import { WorkspaceSessionList } from "./WorkspaceSessionList";

import { closeSidebarOnNarrow, useNewWorkspaceConversation, useWorkspaceSidebar } from "./workspace-navigation";

const FileBrowser = lazy(() => import("./FileBrowser").then(module => ({ default: module.FileBrowser })));

export function SidebarMainArea({ cwd, renderSessions }: { cwd: string; renderSessions?: (query: string) => ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sidebarCollapsed = useUiStore(state => state.sidebarCollapsed);
  const newConversation = useNewWorkspaceConversation(cwd);
  const tab = useWorkspaceSidebar(state => state.cwd === cwd ? state.tab : "sessions");
  const query = useWorkspaceSidebar(state => state.cwd === cwd ? state.query : "");
  const setTab = useWorkspaceSidebar(state => state.setTab);
  const setQuery = useWorkspaceSidebar(state => state.setQuery);
  const [filesVisited, setFilesVisited] = useState(tab === "files");
  useEffect(() => {
    if (useWorkspaceSidebar.getState().cwd !== cwd) useWorkspaceSidebar.getState().showConversations(cwd);
  }, [cwd]);
  const searchId = useId();
  const tabClass = "flex h-nav min-w-0 flex-1 items-center justify-center gap-1.5 rounded-input text-ui-label text-muted transition-colors hover:text-text data-[state=active]:bg-surface-selected data-[state=active]:font-medium data-[state=active]:text-text";
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t("sidebar.workspaceContent")}>
    <button type="button" title={t("conversation.newSession")} onClick={newConversation} className="mb-2 flex h-new-session w-full shrink-0 items-center gap-2 rounded-card border border-border bg-surface-raised px-3 text-left text-ui-label font-medium text-text hover:bg-surface-hover">
      <Plus size={16} className="shrink-0 text-muted" /><span className="truncate">{t("conversation.newSession")}</span>
    </button>
    <Tabs.Root value={tab} onValueChange={value => { if (value !== "sessions" && value !== "files") return; if (value === "files") setFilesVisited(true); setTab(cwd, value); }} className="flex min-h-0 flex-1 flex-col">
      <Tabs.List aria-label={t("sidebar.views")} className="mb-2 flex shrink-0 gap-1 rounded-input bg-surface-2 p-1">
        <Tabs.Trigger value="sessions" className={tabClass}><MessageSquare size={14} />{t("sidebar.conversations")}</Tabs.Trigger>
        <Tabs.Trigger value="files" className={tabClass}><FileText size={14} />{t("nav.files")}</Tabs.Trigger>
      </Tabs.List>
      {/* Keep session lifecycle effects mounted across tabs and collapse. */}
      <Tabs.Content value="sessions" forceMount hidden={tab !== "sessions"} className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        <label className="mb-2 flex h-nav shrink-0 items-center gap-2 rounded-input border border-border px-2 text-muted focus-within:border-accent">
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label={t("sidebar.search")} aria-describedby={searchId} placeholder={t("sidebar.searchPlaceholder")} value={query} onChange={event => setQuery(cwd, event.target.value)} className="min-w-0 flex-1 bg-transparent text-ui-label text-text outline-none placeholder:text-muted" />
        </label>
        <span id={searchId} className="sr-only">{t("sidebar.searchScope")}</span>
        <div className="min-h-0 flex-1 overflow-hidden">{renderSessions ? renderSessions(query) : <WorkspaceSessionList cwd={cwd} query={query} />}</div>
      </Tabs.Content>
      {/* Preserve expanded folders while active controls background requests. */}
      <Tabs.Content value="files" forceMount hidden={tab !== "files"} className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        <div className="min-h-0 flex-1 overflow-hidden">{filesVisited && <Suspense fallback={<div role="status" className="p-2 text-ui-label text-muted">{t("inspector.loading")}</div>}><FileBrowser cwd={cwd} embedded active={tab === "files" && !sidebarCollapsed} /></Suspense>}</div>
        <button type="button" onClick={() => { navigate(`/workspace/${encodeURIComponent(cwd)}/files`); closeSidebarOnNarrow(); }} className="mt-2 h-nav shrink-0 rounded-input px-2 text-left text-ui-label text-muted hover:bg-surface-hover hover:text-text">{t("sidebar.allFiles")} →</button>
      </Tabs.Content>
    </Tabs.Root>
  </section>;
}
