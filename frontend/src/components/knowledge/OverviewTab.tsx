import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import type { ProjectSummary } from "../../lib/knowledge";
import type { ProjectMemoryOverview } from "../../lib/knowledge";
import { MetricCard } from "./MetricCard";

export function OverviewTab({ document, summary, memorySummary }: { document: string; summary: ProjectSummary | null; memorySummary: ProjectMemoryOverview | null }) {
  const { t } = useTranslation();
  const visibleDocument = document
    .replace(/<!--\s*pi-science:project-knowledge:(?:start|end)\s*-->/g, "")
    .replace(/\n{3,}/g, "\n\n");
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_240px]">
      <article className="overflow-hidden rounded-card border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-faint px-5 py-3">
          <div>
            <p className="text-sm font-medium text-text">{t("knowledge.projectDocument")}</p>
            <p className="text-xs text-muted">{t("knowledge.reviewedSource")}</p>
          </div>
        </div>
        <div className="px-5 py-7 sm:px-8">
          <MarkdownViewer variant="document">{visibleDocument}</MarkdownViewer>
        </div>
      </article>
      <aside className="space-y-3">
        <MetricCard label={t("knowledge.acceptedKnowledge")} value={summary?.knowledge_count ?? 0} />
        <MetricCard label={t("knowledge.pendingReview")} value={summary?.pending_count ?? 0} emphasis={(summary?.pending_count ?? 0) > 0} />
        <MetricCard label={t("knowledge.researchRuns")} value={memorySummary?.run_count ?? 0} />
        <MetricCard label={t("knowledge.researchArtifacts")} value={memorySummary?.artifact_count ?? 0} />
        <MetricCard label={t("knowledge.researchLoops")} value={memorySummary?.research_loop_count ?? 0} emphasis={(memorySummary?.active_research_loop_count ?? 0) > 0} />
        <div className="ui-card-flat rounded-card p-4 text-xs leading-5 text-muted">
          <Lock size={15} className="mb-2 text-accent" />
          {t("knowledge.approvalBoundary")}
        </div>
      </aside>
    </div>
  );
}
