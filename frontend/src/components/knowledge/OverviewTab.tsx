import { useMemo, useState } from "react";
import { ArrowUpRight, BookOpen, CheckCircle2, Clock3, FileText, FlaskConical, HelpCircle, Inbox, Lightbulb, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import type { KnowledgeItem, ProjectSummary } from "../../lib/knowledge";
import type { ProjectMemoryOverview } from "../../lib/knowledge";

export function OverviewTab({ document, summary, memorySummary, items = [], onNavigate }: {
  document: string;
  summary: ProjectSummary | null;
  memorySummary: ProjectMemoryOverview | null;
  items?: KnowledgeItem[];
  onNavigate?: (tab: "knowledge" | "inbox" | "research" | "history") => void;
}) {
  const { t } = useTranslation();
  const [showDocument, setShowDocument] = useState(false);
  const visibleDocument = document.replace(/<!--\s*pi-science:project-knowledge:(?:start|end)\s*-->/g, "").replace(/\n{3,}/g, "\n\n");
  const featured = useMemo(() => [...items].filter(item => item.status === "active").sort((a, b) => (b.importance === "critical" ? 2 : b.importance === "important" ? 1 : 0) - (a.importance === "critical" ? 2 : a.importance === "important" ? 1 : 0)).slice(0, 4), [items]);
  const questions = items.filter(item => item.status === "active" && (item.type === "question" || item.type === "hypothesis")).length;
  return (
    <div className="space-y-5">
      <section className="rounded-card border border-border bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="flex items-center gap-2 text-sm font-semibold text-text"><BookOpen size={16} className="text-accent" />{t("knowledge.projectOverviewTitle", { defaultValue: "项目概况" })}</div><p className="mt-1 text-xs text-muted">PROJECT.md · {t("knowledge.reviewedSource")}</p></div>
          <button type="button" onClick={() => setShowDocument(v => !v)} aria-expanded={showDocument} className="flex min-h-10 items-center gap-1.5 rounded-input border border-border px-3 text-xs font-medium text-text hover:bg-surface-2">{showDocument ? t("knowledge.collapseDocument", { defaultValue: "收起文档" }) : t("knowledge.expandDocument", { defaultValue: "查看完整项目文档" })}<ArrowUpRight size={14}/></button>
        </div>
        {showDocument ? <div className="mt-5 rounded-input bg-surface-2 p-3"><div className="mx-auto max-w-[760px] bg-[var(--doc-paper)] p-4"><MarkdownViewer variant="document">{visibleDocument}</MarkdownViewer></div></div> : <p className="mt-4 line-clamp-4 whitespace-pre-line text-sm leading-7 text-muted">{visibleDocument.replace(/^#+\s*/gm, "").trim().slice(0, 600) || t("knowledge.noKnowledgeText")}</p>}
      </section>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: t("knowledge.acceptedKnowledge"), value: summary?.knowledge_count ?? 0, icon: CheckCircle2, target: "knowledge" as const },
          { label: t("knowledge.pendingReview"), value: summary?.pending_count ?? 0, icon: Inbox, target: "inbox" as const },
          { label: t("knowledge.researchLoops"), value: memorySummary?.research_loop_count ?? 0, icon: FlaskConical, target: "research" as const },
          { label: t("knowledge.openQuestions", { defaultValue: "假设与开放问题" }), value: questions, icon: HelpCircle, target: "knowledge" as const },
        ].map(metric => <button key={metric.label} type="button" onClick={() => onNavigate?.(metric.target)} className="rounded-card border border-border bg-surface p-4 text-left transition-colors hover:border-accent/40 hover:bg-surface-2"><div className="flex items-center justify-between text-muted"><span className="text-xs">{metric.label}</span><metric.icon size={16}/></div><div className="mt-3 font-mono text-3xl tabular-nums text-text">{metric.value}</div></button>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-card border border-border bg-surface p-5">
          <div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-base font-semibold text-text"><Lightbulb size={17} className="text-accent"/>{t("knowledge.keyKnowledge", { defaultValue: "关键知识" })}</h2><button type="button" onClick={() => onNavigate?.("knowledge")} className="text-xs text-accent hover:underline">{t("knowledge.viewAll", { defaultValue: "查看全部" })} →</button></div>
          <div className="mt-4 divide-y divide-faint">{featured.length ? featured.map(item => <div key={item.id} className="py-3 first:pt-0"><div className="flex items-center gap-2"><FileText size={14} className="shrink-0 text-muted"/><span className="text-sm font-medium text-text">{item.title}</span></div><p className="mt-1 line-clamp-2 pl-[22px] text-xs leading-5 text-muted">{item.summary}</p></div>) : <p className="py-8 text-center text-sm text-muted">{t("knowledge.noKnowledge")}</p>}</div>
        </section>
        <section className="rounded-card border border-border bg-surface p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-text"><Clock3 size={17} className="text-accent"/>{t("knowledge.nextActions", { defaultValue: "待办与动态" })}</h2>
          <div className="mt-4 space-y-3">
            <button type="button" onClick={() => onNavigate?.("inbox")} className="flex w-full items-center gap-3 rounded-input border border-faint p-3 text-left hover:bg-surface-2"><Inbox size={18} className="text-muted"/><span className="flex-1"><span className="block text-sm font-medium text-text">{summary?.pending_count ?? 0} {t("knowledge.pendingReview")}</span><span className="text-xs text-muted">{t("knowledge.approvalBoundary")}</span></span><ArrowUpRight size={15} className="text-muted"/></button>
            <button type="button" onClick={() => onNavigate?.("research")} className="flex w-full items-center gap-3 rounded-input border border-faint p-3 text-left hover:bg-surface-2"><FlaskConical size={18} className="text-muted"/><span className="flex-1"><span className="block text-sm font-medium text-text">{memorySummary?.run_count ?? 0} {t("knowledge.researchRuns")}</span><span className="text-xs text-muted">{memorySummary?.artifact_count ?? 0} {t("knowledge.researchArtifacts")}</span></span><ArrowUpRight size={15} className="text-muted"/></button>
            <button type="button" onClick={() => onNavigate?.("history")} className="flex w-full items-center gap-3 rounded-input border border-faint p-3 text-left hover:bg-surface-2"><Clock3 size={18} className="text-muted"/><span className="flex-1 text-sm font-medium text-text">{t("knowledge.history")}</span><ArrowUpRight size={15} className="text-muted"/></button>
          </div>
        </section>
      </div>
    </div>
  );
}
