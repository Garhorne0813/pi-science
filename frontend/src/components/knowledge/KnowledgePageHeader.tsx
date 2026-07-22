import { BookOpen, FileText, FlaskConical, FolderOpen, History, Inbox, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/cn";
import type { ProjectPolicy } from "../../lib/project-knowledge";

export type KnowledgePageTab = "overview" | "inbox" | "knowledge" | "research" | "files" | "history";

export function KnowledgePageHeader({
  policy,
  reviewing,
  onToggleAutoReview,
  onReview,
}: {
  policy: ProjectPolicy | null;
  reviewing: boolean;
  onToggleAutoReview: () => void;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-start md:justify-between">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{t("knowledge.eyebrow")}</p>
        <h1 className="mt-1 font-serif text-2xl text-text sm:text-[28px]">{t("knowledge.title")}</h1>
        <p className="mt-1 max-w-[680px] text-sm leading-6 text-muted">{t("knowledge.subtitle")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onToggleAutoReview} aria-pressed={policy?.auto_review ?? false} className={cn("min-h-11 rounded-input border px-3 py-2 text-sm font-medium transition-colors", policy?.auto_review ? "border-ok/40 bg-ok/10 text-ok" : "border-border bg-surface text-muted hover:text-text")}>
          {policy?.auto_review ? t("knowledge.autoReviewOn") : t("knowledge.autoReviewOff")}
        </button>
        <button type="button" onClick={onReview} disabled={reviewing} className="flex min-h-11 items-center gap-1.5 rounded-input bg-accent px-3 py-2 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
          {reviewing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {reviewing ? t("knowledge.reviewing") : t("knowledge.reviewNow")}
        </button>
      </div>
    </header>
  );
}

export function KnowledgePageTabs({ tab, pendingCount, onChange, onRefreshHistory }: {
  tab: KnowledgePageTab;
  pendingCount: number;
  onChange: (tab: KnowledgePageTab) => void;
  onRefreshHistory: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-5 flex items-end gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label={t("knowledge.tabsLabel")}>
      <TabButton active={tab === "overview"} onClick={() => onChange("overview")} icon={<BookOpen size={15} />} label={t("knowledge.overview")} />
      <TabButton active={tab === "inbox"} onClick={() => onChange("inbox")} icon={<Inbox size={15} />} label={t("knowledge.inbox")} badge={pendingCount} />
      <TabButton active={tab === "knowledge"} onClick={() => onChange("knowledge")} icon={<FileText size={15} />} label={t("knowledge.knowledge")} />
      <TabButton active={tab === "research"} onClick={() => onChange("research")} icon={<FlaskConical size={15} />} label={t("knowledge.research")} />
      <TabButton active={tab === "files"} onClick={() => onChange("files")} icon={<FolderOpen size={15} />} label={t("knowledge.files")} />
      <TabButton active={tab === "history"} onClick={() => onChange("history")} icon={<History size={15} />} label={t("knowledge.history")} />
      {tab === "history" && (
        <button type="button" onClick={onRefreshHistory} className="ml-auto mb-1 flex min-h-11 shrink-0 items-center gap-1.5 rounded-input px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-text">
          <RefreshCw size={14} /> {t("knowledge.refresh")}
        </button>
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={cn("relative flex min-h-11 shrink-0 items-center gap-2 px-3 text-sm font-medium transition-colors", active ? "text-text" : "text-muted hover:text-text", active && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent")}>
      {icon}{label}
      {!!badge && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] leading-none text-accent-fg">{badge}</span>}
    </button>
  );
}
