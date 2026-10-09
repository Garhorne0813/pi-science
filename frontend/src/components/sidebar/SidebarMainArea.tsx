import { useId, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, FileText, MessageSquare, Plus, Search } from "lucide-react";
import * as Tabs from "@radix-ui/react-tabs";
import { useUiStore } from "../../lib/ui";
import { FileBrowser } from "./FileBrowser";
import { closeSidebarOnNarrow, useNewWorkspaceConversation } from "./workspace-navigation";

export function SidebarMainArea({ cwd, renderSessions }: { cwd: string; renderSessions: (query: string) => ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sidebarCollapsed = useUiStore(state => state.sidebarCollapsed);
  const newConversation = useNewWorkspaceConversation(cwd);
  const [tab, setTab] = useState("sessions");
  const [query, setQuery] = useState("");
  const searchId = useId();
  const tabClass = "flex h-nav min-w-0 flex-1 items-center justify-center gap-1.5 rounded-input border border-transparent px-1 text-ui-label text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-[state=active]:border-border data-[state=active]:bg-surface-raised data-[state=active]:font-medium data-[state=active]:text-text data-[state=active]:shadow-sm";
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t("sidebar.workspaceContent")}>
    <button type="button" title={t("conversation.newSession")} onClick={() => { setTab("sessions"); setQuery(""); newConversation(); }} className="mb-3 flex h-new-session w-full shrink-0 items-center gap-2 rounded-card border border-border bg-surface-raised px-2 text-left text-ui-label font-medium text-text shadow-sm transition-colors hover:border-accent/30 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
      <span className="flex h-tool w-tool shrink-0 items-center justify-center rounded-input bg-accent-soft text-accent"><Plus size={16} aria-hidden="true" /></span>
      <span className="min-w-0 flex-1 truncate">{t("conversation.newSession")}</span>
    </button>
    <Tabs.Root value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
      <Tabs.List aria-label={t("sidebar.views")} className="mb-2 flex shrink-0 gap-1 rounded-card bg-surface-2 p-1">
        <Tabs.Trigger value="sessions" className={tabClass}><MessageSquare size={14} />{t("sidebar.conversations")}</Tabs.Trigger>
        <Tabs.Trigger value="files" className={tabClass}><FileText size={14} />{t("nav.files")}</Tabs.Trigger>
      </Tabs.List>
      {/* Keep session lifecycle effects mounted across tabs and collapse. */}
      <Tabs.Content value="sessions" forceMount hidden={tab !== "sessions"} className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        <label className="mb-2 flex h-control shrink-0 items-center gap-2 rounded-input border border-transparent bg-surface-2 px-2 text-muted transition-colors focus-within:border-accent/40 focus-within:bg-surface-raised">
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label={t("sidebar.search")} aria-describedby={searchId} placeholder={t("sidebar.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-ui-label text-text outline-none placeholder:text-muted" />
        </label>
        <span id={searchId} className="sr-only">{t("sidebar.searchScope")}</span>
        <div className="min-h-0 flex-1 overflow-hidden">{renderSessions(query)}</div>
      </Tabs.Content>
      {/* Preserve expanded folders while active controls background requests. */}
      <Tabs.Content value="files" forceMount hidden={tab !== "files"} className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        <div className="min-h-0 flex-1 overflow-hidden"><FileBrowser cwd={cwd} embedded active={tab === "files" && !sidebarCollapsed} /></div>
        <button type="button" onClick={() => { navigate(`/workspace/${encodeURIComponent(cwd)}/files`); closeSidebarOnNarrow(); }} className="mt-2 flex h-nav shrink-0 items-center justify-between rounded-input px-2 text-left text-ui-label text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{t("sidebar.allFiles")}<ArrowRight size={14} aria-hidden="true" /></button>
      </Tabs.Content>
    </Tabs.Root>
  </section>;
}
