import type { Ref } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Activity, FlaskConical, Inbox, MessageSquare, PanelLeft, Settings, SquarePen, type LucideIcon } from "lucide-react";
import { cn, useUiStore } from "../../lib/ui";
import { usePendingProposalCount } from "../../lib/knowledge";
import { Icon, IconButton } from "../ui/Icon";
import { preloadSettingsContent } from "../settings/settings-loading";
import { primarySection } from "./primary-section";
import { closeSidebarOnNarrow, useNewWorkspaceConversation, useWorkspaceSidebar } from "./workspace-navigation";

const railBox = "relative flex h-header w-header shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-hover hover:text-text";
const currentBox = "bg-surface-selected text-accent before:absolute before:-left-2 before:h-[26px] before:w-[3px] before:rounded-[3px] before:bg-accent before:content-['']";
function RailLink({ to, icon, label, current, count, onNavigate }: { to: string; icon: LucideIcon; label: string; current: boolean; count?: number; onNavigate?: () => void }) {
  return <Link to={to} title={label} aria-label={label} aria-current={current ? "page" : undefined} onClick={() => { onNavigate?.(); closeSidebarOnNarrow(); }} className={cn(railBox, current && currentBox)}><Icon icon={icon} size="lg" />{!!count && <span aria-hidden="true" className="absolute right-0 top-0 flex h-[var(--rail-badge-size)] min-w-[var(--rail-badge-size)] items-center justify-center rounded-[9px] bg-accent-fill px-1 text-ui-micro text-accent-fg">{count}</span>}</Link>;
}
function KnowledgeRailLink({ cwd, current }: { cwd: string; current: boolean }) {
  const { t } = useTranslation();
  const { data } = usePendingProposalCount(cwd);
  const count = Number(data?.pending_count) || 0;
  const label = count ? `${t("nav.knowledge")} (${t("sidebar.pendingKnowledge", { count })})` : t("nav.knowledge");
  return <RailLink to={`/workspace/${encodeURIComponent(cwd)}/knowledge`} icon={Inbox} label={label} current={current} count={count} />;
}
export function WorkspaceRail({ cwd, toggleRef }: { cwd: string | null; toggleRef?: Ref<HTMLButtonElement> }) {
  const { t } = useTranslation();
  const location = useLocation();
  const section = primarySection(location.pathname, cwd);
  const collapsed = useUiStore(state => state.contextPanelCollapsed);
  const setCollapsed = useUiStore(state => state.setContextPanelCollapsed);
  const settingsOpen = useUiStore(state => state.settingsOpen);
  const newConversation = useNewWorkspaceConversation(cwd);
  const root = cwd ? `/workspace/${encodeURIComponent(cwd)}` : "";
  return <nav aria-label={t("shell.primaryNav")} className="app-sidebar rail-enter z-[60] flex h-full w-[var(--rail-width-mobile)] shrink-0 flex-col items-center gap-1.5 border-r border-faint py-panel md:w-[var(--rail-width)]">
    <Link to="/" title={t("nav.projects")} aria-label={t("nav.projects")} aria-current={section === "projects" ? "page" : undefined} onClick={closeSidebarOnNarrow} className={cn(railBox, "bg-surface-2 text-ui-title font-semibold", section === "projects" && currentBox)}>pi</Link>
    {cwd && <IconButton ref={toggleRef} icon={PanelLeft} label={t("shell.toggleContextPanel")} aria-controls="workspace-context-panel" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)} className="h-header w-header" />}
    <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden md:px-2">
      {cwd && <><IconButton icon={SquarePen} label={t("conversation.newSession")} onClick={() => newConversation()} className="h-header w-header border border-accent-border bg-accent-soft text-accent hover:bg-surface-selected hover:text-accent" /><RailLink to={root} icon={MessageSquare} label={t("sidebar.conversations")} current={section === "conversations"} onNavigate={() => useWorkspaceSidebar.getState().showConversations(cwd)} /><KnowledgeRailLink cwd={cwd} current={section === "knowledge"} /><RailLink to={`${root}/research`} icon={FlaskConical} label={t("nav.research")} current={section === "research"} /><RailLink to={`${root}/runs`} icon={Activity} label={t("sidebar.runs")} current={section === "runs"} /></>}
    </div>
    <IconButton icon={Settings} label={t("nav.settings")} aria-expanded={settingsOpen} onClick={() => { preloadSettingsContent(); useUiStore.getState().openSettings(cwd); closeSidebarOnNarrow(); }} onPointerEnter={preloadSettingsContent} onFocus={preloadSettingsContent} className={cn("h-header w-header", settingsOpen && "bg-surface-selected text-accent")} />
  </nav>;
}
