import type { Ref } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Activity, FlaskConical, FolderOpen, Inbox, MessageSquare, Settings, SquarePen, type LucideIcon } from "lucide-react";
import { cn, useUiStore } from "../../lib/ui";
import { usePendingProposalCount } from "../../lib/knowledge";
import { Icon } from "../ui/Icon";
import { preloadSettingsContent } from "../settings/settings-loading";
import { primarySection } from "./primary-section";
import { closeSidebarOnNarrow, useNewWorkspaceConversation, useWorkspaceSidebar } from "./workspace-navigation";

const railLayout = "relative flex h-header shrink-0 items-center rounded-input";
const railInteraction = "transition-colors hover:bg-surface-hover hover:text-text";
const railBox = cn(railLayout, "w-full text-muted", railInteraction);
const brandBox = cn(railLayout, "mx-[7px] w-[calc(100%-14px)] bg-surface-2 text-text md:mx-2 md:w-[calc(100%-16px)]");
const brandMark = <span className="flex h-header w-header shrink-0 items-center justify-center text-ui-title font-semibold">pi</span>;
const currentBox = "bg-surface-selected text-accent before:absolute before:-left-2 before:h-[26px] before:w-[3px] before:rounded-[3px] before:bg-accent before:content-['']";

function RailLabel({ label }: { label: string }) {
  return <span className="workspace-rail-label min-w-0 flex-1 truncate pr-2 text-left text-ui-label font-medium">{label}</span>;
}
function RailGlyph({ icon, count }: { icon: LucideIcon; count?: number }) {
  return <span className="relative flex h-header w-header shrink-0 items-center justify-center"><Icon icon={icon} size="lg" />{!!count && <span aria-hidden="true" className="absolute right-0 top-0 flex h-[var(--rail-badge-size)] min-w-[var(--rail-badge-size)] items-center justify-center rounded-[9px] bg-accent-fill px-1 text-ui-micro text-accent-fg">{count}</span>}</span>;
}
function RailLink({ to, icon, label, current, count, onNavigate }: { to: string; icon: LucideIcon; label: string; current: boolean; count?: number; onNavigate?: () => void }) {
  return <Link to={to} title={label} aria-label={label} aria-current={current ? "page" : undefined} onClick={() => { onNavigate?.(); closeSidebarOnNarrow(); }} className={cn(railBox, current && currentBox)}><RailGlyph icon={icon} count={count} /><RailLabel label={label} /></Link>;
}
function KnowledgeRailLink({ cwd, current }: { cwd: string; current: boolean }) {
  const { t } = useTranslation();
  const { data } = usePendingProposalCount(cwd);
  const count = Number(data?.pending_count) || 0;
  const label = count ? `${t("nav.knowledge")} (${t("sidebar.pendingKnowledge", { count })})` : t("nav.knowledge");
  return <RailLink to={`/workspace/${encodeURIComponent(cwd)}/knowledge`} icon={Inbox} label={label} current={current} count={count} />;
}
export function WorkspaceRail({ cwd, toggleRef, onExpand }: { cwd: string | null; toggleRef?: Ref<HTMLButtonElement>; onExpand?: (trigger: HTMLButtonElement) => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const section = primarySection(location.pathname, cwd);
  const collapsed = useUiStore(state => state.contextPanelCollapsed);
  const setCollapsed = useUiStore(state => state.setContextPanelCollapsed);
  const settingsOpen = useUiStore(state => state.settingsOpen);
  const newConversation = useNewWorkspaceConversation(cwd);
  const sessionMatch = location.pathname.match(/\/session\/([^/]+)/);
  const sessionId = sessionMatch ? decodeURIComponent(sessionMatch[1]) : new URLSearchParams(location.search).get("session_id");
  const runsSearch = sessionId ? `?${new URLSearchParams({ session_id: sessionId })}` : "";
  const root = cwd ? `/workspace/${encodeURIComponent(cwd)}` : "";
  // The slot stays rail-width; the nav itself grows above the context panel on hover.
  return <div data-workspace-rail-slot className="relative z-[70] h-full w-[var(--rail-width-mobile)] shrink-0 md:w-[var(--rail-width)]">
    <nav aria-label={t("shell.primaryNav")} className="app-sidebar rail-enter workspace-rail absolute inset-y-0 left-0 flex h-full w-[var(--rail-width-mobile)] flex-col items-center gap-1.5 overflow-hidden border-r border-faint py-panel md:w-[var(--rail-width)]">
      {!cwd && <Link key="projects" to="/" title={t("nav.projects")} aria-label={t("nav.projects")} aria-current={section === "projects" ? "page" : undefined} onClick={closeSidebarOnNarrow} className={cn(brandBox, railInteraction, section === "projects" && currentBox, "text-text")}>{brandMark}<RailLabel label={t("nav.projects")} /></Link>}
      {cwd && !collapsed && <div className={brandBox}>{brandMark}<RailLabel label="pi-science" /></div>}
      {cwd && collapsed && <button key="context-toggle" ref={toggleRef} type="button" aria-label={t("shell.expandContextPanel")} title={t("shell.expandContextPanel")} aria-controls="workspace-context-panel" aria-expanded={false} onClick={event => onExpand ? onExpand(event.currentTarget) : setCollapsed(false)} className={cn(brandBox, railInteraction)}>{brandMark}<RailLabel label={t("shell.expandContextPanel")} /></button>}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-x-hidden overflow-y-auto px-[7px] md:px-2">
        {cwd && <><button type="button" title={t("conversation.newSession")} aria-label={t("conversation.newSession")} onClick={() => newConversation()} className={railBox}><RailGlyph icon={SquarePen} /><RailLabel label={t("conversation.newSession")} /></button><RailLink to={root} icon={MessageSquare} label={t("sidebar.conversations")} current={section === "conversations"} onNavigate={() => useWorkspaceSidebar.getState().showConversations(cwd)} /><KnowledgeRailLink cwd={cwd} current={section === "knowledge"} /><RailLink to={`${root}/research`} icon={FlaskConical} label={t("nav.research")} current={section === "research"} /><RailLink to={`${root}/runs${runsSearch}`} icon={Activity} label={t("sidebar.runs")} current={section === "runs"} /></>}
      </div>
      <div className="flex w-full shrink-0 flex-col items-center gap-1.5 px-[7px] md:px-2">
        {cwd && <RailLink to="/" icon={FolderOpen} label={t("nav.projects")} current={false} />}
        <button type="button" title={t("nav.settings")} aria-label={t("nav.settings")} aria-expanded={settingsOpen} onClick={() => { preloadSettingsContent(); useUiStore.getState().openSettings(cwd); closeSidebarOnNarrow(); }} onPointerEnter={preloadSettingsContent} onFocus={preloadSettingsContent} className={cn(railBox, settingsOpen && "bg-surface-selected text-accent")}><RailGlyph icon={Settings} /><RailLabel label={t("nav.settings")} /></button>
      </div>
    </nav>
  </div>;
}
