import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/cn";
import {
  projectKnowledgeApi,
  projectKnowledgeKey,
  type KnowledgeItem,
  type ProjectPolicy,
  type ProjectSummary,
  type Proposal,
} from "../../lib/project-knowledge";
import { queryClient } from "../../lib/query-client";
import { useRuntimeStore } from "../../lib/runtime-store";
import { KnowledgePageHeader, KnowledgePageTabs, type KnowledgePageTab } from "../../components/knowledge/KnowledgePageHeader";
import { FilesTab } from "../../components/knowledge/FilesTab";
import { HistoryTab } from "../../components/knowledge/HistoryTab";
import { InboxTab } from "../../components/knowledge/InboxTab";
import { KnowledgeTab } from "../../components/knowledge/KnowledgeTab";
import { OverviewTab } from "../../components/knowledge/OverviewTab";
import { ResearchTab } from "../../components/knowledge/ResearchTab";
import { WorkspacePage } from "../../components/layout/WorkspacePage";
import { projectMemoryApi, projectMemoryKey, type ProjectMemoryOverview } from "../../lib/project-memory";
import { useRequiredWorkspaceCwd } from "../../lib/workspace-context";

export function KnowledgePage() {
  const { t } = useTranslation();
  const cwd = useRequiredWorkspaceCwd();
  const activeSessionId = useRuntimeStore((state) => state.activeSessionId);
  const [tab, setTab] = useState<KnowledgePageTab>("overview");
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [memorySummary, setMemorySummary] = useState<ProjectMemoryOverview | null>(null);
  const [projectDocument, setProjectDocument] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [policy, setPolicy] = useState<ProjectPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = useMemo(() => proposals.filter((proposal) => proposal.status === "pending"), [proposals]);

  /** The five reads the page itself renders. The files, history and research tabs own
   *  their own queries, so nothing here loads data for a tab that is not on screen. */
  const loadCore = useCallback(async () => {
    setError(null);
    try {
      const [project, proposalData, itemData, currentPolicy, memory] = await Promise.all([
        projectKnowledgeApi.project(cwd),
        projectKnowledgeApi.proposals(cwd),
        projectKnowledgeApi.items(cwd),
        projectKnowledgeApi.policy(cwd),
        projectMemoryApi.overview(cwd),
      ]);
      setSummary(project);
      setProjectDocument(project.content);
      setProposals(proposalData.proposals);
      setItems(itemData.items);
      setPolicy(currentPolicy);
      setMemorySummary(memory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("knowledge.loadError"));
    } finally {
      setLoading(false);
    }
  }, [cwd, t]);

  useEffect(() => { void loadCore(); }, [loadCore]);

  /** Knowledge writes only invalidate the project-knowledge resource; the timeline the
   *  history tab renders lives under project-memory and is dropped explicitly. */
  const reloadWithTimeline = useCallback(async () => {
    void queryClient.invalidateQueries({ queryKey: projectMemoryKey("timeline", cwd) });
    await loadCore();
  }, [cwd, loadCore]);

  const runReviewer = async () => {
    setReviewing(true);
    setError(null);
    setMessage(null);
    try {
      const result = await projectKnowledgeApi.review(cwd, activeSessionId);
      setMessage(result.created > 0
        ? t("knowledge.reviewCreated", { count: result.created })
        : result.message || t("knowledge.noNewProposals"));
      await loadCore();
      if (result.created > 0) setTab("inbox");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("knowledge.reviewerError"));
    } finally {
      setReviewing(false);
    }
  };

  const decide = async (proposal: Proposal, action: "accept" | "reject", edits?: Partial<Proposal>) => {
    setError(null);
    try {
      if (action === "accept") {
        await projectKnowledgeApi.accept(cwd, proposal.id, { title: edits?.title, summary: edits?.summary });
        setMessage(t("knowledge.acceptedOne"));
      } else {
        await projectKnowledgeApi.reject(cwd, proposal.id);
        setMessage(t("knowledge.rejectedOne"));
      }
      if (proposal.proposal_type === "file_operation") await reloadWithTimeline();
      else await loadCore();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("knowledge.proposalUpdateError"));
      throw cause;
    }
  };

  const updateProposal = async (proposal: Proposal, changes: Partial<Proposal>) => {
    await projectKnowledgeApi.updateProposal(cwd, proposal.id, changes);
    await loadCore();
  };

  const toggleAutoReview = async () => {
    if (!policy) return;
    try {
      const updated = await projectKnowledgeApi.updatePolicy(cwd, { auto_review: !policy.auto_review });
      setPolicy(updated);
      setSummary((current) => current ? { ...current, auto_review: updated.auto_review } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("knowledge.policyUpdateError"));
    }
  };

  /** Refresh drops whatever the visible tab renders; the tab's own query refetches. */
  const refresh = () => {
    if (tab === "research") void queryClient.invalidateQueries({ queryKey: projectMemoryKey("research-loops", cwd) });
    else if (tab === "files") void queryClient.invalidateQueries({ queryKey: projectKnowledgeKey("file-views", cwd) });
    else if (tab === "history") void queryClient.invalidateQueries({ queryKey: projectMemoryKey("timeline", cwd) });
    else void loadCore();
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-muted"><Loader2 className="animate-spin" size={22} /></div>;
  }

  return (
    <WorkspacePage className="[&_button]:!min-h-9 [&_button]:!text-xs">
        <KnowledgePageHeader policy={policy} reviewing={reviewing} onToggleAutoReview={() => void toggleAutoReview()} onReview={() => void runReviewer()} />

        {(error || message) && (
          <div
            aria-live="polite"
            className={cn(
              "mt-4 whitespace-pre-wrap rounded-input border px-4 py-3 text-sm",
              error ? "border-error/30 bg-error/5 text-error" : "border-ok/30 bg-ok/5 text-ok",
            )}
          >
            {error || message}
          </div>
        )}

        <KnowledgePageTabs tab={tab} pendingCount={pending.length} onChange={setTab} onRefresh={refresh} />

        <main className="py-6">
          {tab === "overview" && (
            <OverviewTab
              document={projectDocument}
              summary={summary}
              memorySummary={memorySummary}
            />
          )}
          {tab === "inbox" && (
            <InboxTab
              cwd={cwd}
              proposals={pending}
              onDecide={decide}
              onUpdate={updateProposal}
              onChanged={reloadWithTimeline}
              onMessage={setMessage}
              onError={setError}
            />
          )}
          {tab === "knowledge" && <KnowledgeTab items={items} />}
          {tab === "research" && (
            <ResearchTab
              cwd={cwd}
              onError={setError}
            />
          )}
          {tab === "files" && (
            <FilesTab
              cwd={cwd}
              policy={policy}
              onPolicyChange={(next) => { setPolicy(next); setSummary((current) => current ? { ...current, auto_review: next.auto_review } : current); }}
              onError={setError}
            />
          )}
          {tab === "history" && (
            <HistoryTab
              cwd={cwd}
              onChanged={loadCore}
              onError={setError}
            />
          )}
        </main>
    </WorkspacePage>
  );
}
