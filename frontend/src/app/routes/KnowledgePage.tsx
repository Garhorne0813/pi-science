import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  History,
  Inbox,
  Loader2,
  Lock,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { MarkdownViewer } from "../../components/markdown-viewer/MarkdownViewer";
import { cn } from "../../lib/cn";
import {
  formatFileSize,
  groupKnowledgeItems,
  KNOWLEDGE_LABELS,
  projectKnowledgeApi,
  type FileOperation,
  type KnowledgeItem,
  type LogicalFileViews,
  type ProjectPolicy,
  type ProjectSummary,
  type Proposal,
} from "../../lib/project-knowledge";
import { useRuntimeStore } from "../../lib/runtime-store";
import { useUiStore } from "../../lib/store";

type Tab = "overview" | "inbox" | "knowledge" | "files" | "history";

export function KnowledgePage() {
  const { t } = useTranslation();
  const { cwd: rawCwd } = useParams<{ cwd: string }>();
  const cwd = rawCwd ? decodeURIComponent(rawCwd) : ".";
  const activeSessionId = useRuntimeStore((state) => state.activeSessionId);
  const [tab, setTab] = useState<Tab>("overview");
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [projectDocument, setProjectDocument] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [policy, setPolicy] = useState<ProjectPolicy | null>(null);
  const [files, setFiles] = useState<LogicalFileViews | null>(null);
  const [historyRows, setHistoryRows] = useState<Array<Record<string, unknown>>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = useMemo(() => proposals.filter((proposal) => proposal.status === "pending"), [proposals]);

  const loadCore = useCallback(async () => {
    setError(null);
    try {
      const [project, proposalData, itemData, currentPolicy] = await Promise.all([
        projectKnowledgeApi.project(cwd),
        projectKnowledgeApi.proposals(cwd),
        projectKnowledgeApi.items(cwd),
        projectKnowledgeApi.policy(cwd),
      ]);
      setSummary(project);
      setProjectDocument(project.content);
      setProposals(proposalData.proposals);
      setItems(itemData.items);
      setPolicy(currentPolicy);
      setSelected((current) => {
        const valid = new Set(proposalData.proposals.filter((item) => item.status === "pending").map((item) => item.id));
        return new Set([...current].filter((id) => valid.has(id)));
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load project knowledge");
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  const loadFiles = useCallback(async () => {
    try {
      setFiles(await projectKnowledgeApi.files(cwd));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load file views");
    }
  }, [cwd]);

  const loadHistory = useCallback(async () => {
    try {
      const data = await projectKnowledgeApi.history(cwd);
      setHistoryRows(data.history);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load history");
    }
  }, [cwd]);

  useEffect(() => { void loadCore(); }, [loadCore]);
  useEffect(() => {
    if (tab === "files" && files === null) void loadFiles();
    if (tab === "history") void loadHistory();
  }, [tab, files, loadFiles, loadHistory]);

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
      setError(cause instanceof Error ? cause.message : "Reviewer failed");
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
      await loadCore();
      if (proposal.proposal_type === "file_operation") {
        setFiles(null);
        await loadHistory();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update proposal");
      throw cause;
    }
  };

  const updateProposal = async (proposal: Proposal, changes: Partial<Proposal>) => {
    await projectKnowledgeApi.updateProposal(cwd, proposal.id, changes);
    await loadCore();
  };

  const batch = async (action: "accept" | "reject") => {
    if (selected.size === 0) return;
    setError(null);
    try {
      const result = await projectKnowledgeApi.batch(cwd, [...selected], action);
      if (result.failures.length) {
        setError(result.failures.map((failure) => `${failure.proposal_id}: ${failure.detail}`).join("\n"));
      } else {
        setMessage(action === "accept" ? t("knowledge.acceptedBatch") : t("knowledge.rejectedBatch"));
      }
      setSelected(new Set());
      setFiles(null);
      await Promise.all([loadCore(), loadHistory()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Batch update failed");
    }
  };

  const toggleAutoReview = async () => {
    if (!policy) return;
    try {
      const updated = await projectKnowledgeApi.updatePolicy(cwd, { auto_review: !policy.auto_review });
      setPolicy(updated);
      setSummary((current) => current ? { ...current, auto_review: updated.auto_review } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update Reviewer settings");
    }
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-muted"><Loader2 className="animate-spin" size={22} /></div>;
  }

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-[1120px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <header className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{t("knowledge.eyebrow")}</p>
            <h1 className="mt-1 font-serif text-2xl text-text sm:text-[28px]">{t("knowledge.title")}</h1>
            <p className="mt-1 max-w-[680px] text-sm leading-6 text-muted">{t("knowledge.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={toggleAutoReview}
              aria-pressed={policy?.auto_review ?? false}
              className={cn(
                "min-h-11 rounded-input border px-3 py-2 text-xs font-medium transition-colors",
                policy?.auto_review ? "border-ok/40 bg-ok/10 text-ok" : "border-border bg-surface text-muted hover:text-text",
              )}
            >
              {policy?.auto_review ? t("knowledge.autoReviewOn") : t("knowledge.autoReviewOff")}
            </button>
            <button
              type="button"
              onClick={runReviewer}
              disabled={reviewing}
              className="flex min-h-11 items-center gap-2 rounded-input bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {reviewing ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {reviewing ? t("knowledge.reviewing") : t("knowledge.reviewNow")}
            </button>
          </div>
        </header>

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

        <div className="mt-5 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label={t("knowledge.tabsLabel")}>
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<BookOpen size={15} />} label={t("knowledge.overview")} />
          <TabButton active={tab === "inbox"} onClick={() => setTab("inbox")} icon={<Inbox size={15} />} label={t("knowledge.inbox")} badge={pending.length} />
          <TabButton active={tab === "knowledge"} onClick={() => setTab("knowledge")} icon={<FileText size={15} />} label={t("knowledge.knowledge")} />
          <TabButton active={tab === "files"} onClick={() => setTab("files")} icon={<FolderOpen size={15} />} label={t("knowledge.files")} />
          <TabButton active={tab === "history"} onClick={() => setTab("history")} icon={<History size={15} />} label={t("knowledge.history")} />
        </div>

        <main className="py-6">
          {tab === "overview" && (
            <OverviewTab
              document={projectDocument}
              summary={summary}
              onRefresh={loadCore}
            />
          )}
          {tab === "inbox" && (
            <InboxTab
              cwd={cwd}
              proposals={pending}
              selected={selected}
              setSelected={setSelected}
              onDecide={decide}
              onUpdate={updateProposal}
              onBatch={batch}
            />
          )}
          {tab === "knowledge" && <KnowledgeTab items={items} />}
          {tab === "files" && (
            <FilesTab
              cwd={cwd}
              views={files}
              policy={policy}
              onRefresh={loadFiles}
              onPolicyChange={(next) => { setPolicy(next); setSummary((current) => current ? { ...current, auto_review: next.auto_review } : current); }}
              onError={setError}
            />
          )}
          {tab === "history" && (
            <HistoryTab
              cwd={cwd}
              rows={historyRows}
              onRefresh={loadHistory}
              onChanged={async () => { setFiles(null); await Promise.all([loadCore(), loadHistory()]); }}
              onError={setError}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex min-h-11 shrink-0 items-center gap-2 px-3 text-sm font-medium transition-colors",
        active ? "text-text" : "text-muted hover:text-text",
        active && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent",
      )}
    >
      {icon}
      {label}
      {!!badge && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] leading-none text-accent-fg">{badge}</span>}
    </button>
  );
}

function OverviewTab({ document, summary, onRefresh }: { document: string; summary: ProjectSummary | null; onRefresh: () => Promise<void> }) {
  const { t } = useTranslation();
  const visibleDocument = document
    .replace(/<!--\s*pi-science:project-knowledge:(?:start|end)\s*-->/g, "")
    .replace(/\n{3,}/g, "\n\n");
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_240px]">
      <article className="overflow-hidden rounded-card border border-border bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-[#eee7dc] px-5 py-3">
          <div>
            <p className="text-sm font-medium text-[#2b2620]">PROJECT.md</p>
            <p className="text-xs text-[#8c8174]">{t("knowledge.reviewedSource")}</p>
          </div>
          <button type="button" onClick={() => void onRefresh()} aria-label={t("knowledge.refresh")} className="flex min-h-11 min-w-11 items-center justify-center rounded-input text-[#8c8174] hover:bg-[#f7f0ea] hover:text-[#2b2620]">
            <RefreshCw size={15} />
          </button>
        </div>
        <div className="px-5 py-7 sm:px-8">
          <MarkdownViewer variant="document">{visibleDocument}</MarkdownViewer>
        </div>
      </article>
      <aside className="space-y-3">
        <MetricCard label={t("knowledge.acceptedKnowledge")} value={summary?.knowledge_count ?? 0} />
        <MetricCard label={t("knowledge.pendingReview")} value={summary?.pending_count ?? 0} emphasis={(summary?.pending_count ?? 0) > 0} />
        <div className="rounded-card border border-border bg-surface p-4 text-xs leading-5 text-muted">
          <Lock size={15} className="mb-2 text-accent" />
          {t("knowledge.approvalBoundary")}
        </div>
      </aside>
    </div>
  );
}

function MetricCard({ label, value, emphasis = false }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className={cn("rounded-card border bg-surface p-4 shadow-card", emphasis ? "border-accent/40" : "border-border")}>
      <div className="font-mono text-2xl tabular-nums text-text">{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}

function InboxTab({
  cwd,
  proposals,
  selected,
  setSelected,
  onDecide,
  onUpdate,
  onBatch,
}: {
  cwd: string;
  proposals: Proposal[];
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  onDecide: (proposal: Proposal, action: "accept" | "reject", edits?: Partial<Proposal>) => Promise<void>;
  onUpdate: (proposal: Proposal, changes: Partial<Proposal>) => Promise<void>;
  onBatch: (action: "accept" | "reject") => Promise<void>;
}) {
  const { t } = useTranslation();
  const allSelected = proposals.length > 0 && proposals.every((proposal) => selected.has(proposal.id));
  if (proposals.length === 0) {
    return <EmptyState icon={<Inbox size={28} />} title={t("knowledge.inboxEmpty")} text={t("knowledge.inboxEmptyText")} />;
  }
  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 rounded-card border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 px-1 text-sm text-text">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(event) => setSelected(event.target.checked ? new Set(proposals.map((proposal) => proposal.id)) : new Set())}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          {t("knowledge.selectAll")} ({selected.size}/{proposals.length})
        </label>
        <div className="flex gap-2">
          <button type="button" disabled={selected.size === 0} onClick={() => void onBatch("reject")} className="min-h-11 rounded-input border border-border px-3 py-2 text-sm text-muted hover:border-error/40 hover:text-error disabled:cursor-not-allowed disabled:opacity-40">
            {t("knowledge.rejectSelected")}
          </button>
          <button type="button" disabled={selected.size === 0} onClick={() => void onBatch("accept")} className="min-h-11 rounded-input bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
            {t("knowledge.acceptSelected")}
          </button>
        </div>
      </div>
      <div className="space-y-4">
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            cwd={cwd}
            proposal={proposal}
            selected={selected.has(proposal.id)}
            onSelect={(value) => setSelected((current) => {
              const next = new Set(current);
              if (value) next.add(proposal.id); else next.delete(proposal.id);
              return next;
            })}
            onDecide={onDecide}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </div>
  );
}

function ProposalCard({
  cwd,
  proposal,
  selected,
  onSelect,
  onDecide,
  onUpdate,
}: {
  cwd: string;
  proposal: Proposal;
  selected: boolean;
  onSelect: (value: boolean) => void;
  onDecide: (proposal: Proposal, action: "accept" | "reject", edits?: Partial<Proposal>) => Promise<void>;
  onUpdate: (proposal: Proposal, changes: Partial<Proposal>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(proposal.title);
  const [summary, setSummary] = useState(proposal.summary);
  const [operations, setOperations] = useState<FileOperation[]>(proposal.operations.map((item) => ({ ...item })));
  const [busy, setBusy] = useState<"accept" | "reject" | "save" | "preview" | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const knowledgeLabel = proposal.knowledge_type ? KNOWLEDGE_LABELS[proposal.knowledge_type] : t("knowledge.fileOperation");

  const save = async () => {
    setBusy("save");
    setLocalError(null);
    try {
      await onUpdate(proposal, { title, summary, operations });
      setEditing(false);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Unable to save proposal");
    } finally {
      setBusy(null);
    }
  };

  const decide = async (action: "accept" | "reject") => {
    setBusy(action);
    setLocalError(null);
    try {
      if (editing) await onUpdate(proposal, { title, summary, operations });
      await onDecide(proposal, action, { title, summary });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Unable to update proposal");
    } finally {
      setBusy(null);
    }
  };

  const loadPreview = async () => {
    setBusy("preview");
    setLocalError(null);
    try {
      setPreview(await projectKnowledgeApi.previewProposal(cwd, proposal.id));
      setExpanded(true);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Unable to preview proposal");
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={cn("rounded-card border bg-surface shadow-card transition-colors", selected ? "border-accent/50" : "border-border")}>
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <label className="flex min-h-11 min-w-8 cursor-pointer items-start justify-center pt-1" aria-label={t("knowledge.selectProposal")}>
          <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
        </label>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text">{knowledgeLabel}</span>
            <span className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium",
              proposal.importance === "critical" ? "bg-error/10 text-error" : proposal.importance === "important" ? "bg-warn/10 text-warn" : "bg-surface-2 text-muted",
            )}>{proposal.importance}</span>
            <span className="text-[11px] text-muted">{proposal.confidence} confidence</span>
          </div>

          {editing ? (
            <div className="mt-3 space-y-3">
              <label className="block text-xs font-medium text-muted">
                {t("knowledge.proposalTitle")}
                <input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 min-h-11 w-full rounded-input border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <label className="block text-xs font-medium text-muted">
                {t("knowledge.proposalSummary")}
                <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={4} className="mt-1 w-full rounded-input border border-border bg-bg px-3 py-2 text-sm leading-6 text-text outline-none focus:border-accent" />
              </label>
              {proposal.proposal_type === "file_operation" && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted">{t("knowledge.operations")}</div>
                  {operations.map((operation, index) => (
                    <div key={`${operation.type}-${operation.target}-${index}`} className="grid gap-2 rounded-input border border-border bg-bg p-3 sm:grid-cols-[110px_1fr_1fr]">
                      <select value={operation.type} onChange={(event) => setOperations((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as FileOperation["type"] } : item))} className="min-h-11 rounded-input border border-border bg-surface px-2 text-sm text-text">
                        <option value="mkdir">mkdir</option>
                        <option value="move">move</option>
                        <option value="rename">rename</option>
                      </select>
                      {operation.type !== "mkdir" && (
                        <input aria-label="Source path" value={operation.source || ""} onChange={(event) => setOperations((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, source: event.target.value } : item))} className="min-h-11 rounded-input border border-border bg-surface px-3 text-sm text-text" />
                      )}
                      <input aria-label="Target path" value={operation.target} onChange={(event) => setOperations((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, target: event.target.value } : item))} className="min-h-11 rounded-input border border-border bg-surface px-3 text-sm text-text" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <h2 className="mt-3 text-base font-semibold leading-6 text-text">{proposal.title}</h2>
              <div className="mt-3 rounded-input border border-border bg-bg px-3 py-3">
                {proposal.proposal_type === "knowledge" ? (
                  <div className="font-mono text-[12px] leading-5">
                    <div className="text-ok">+ [{knowledgeLabel}] {proposal.title}</div>
                    <div className="mt-1 whitespace-pre-wrap text-text">+ {proposal.summary}</div>
                  </div>
                ) : (
                  <OperationList operations={proposal.operations} />
                )}
              </div>
            </>
          )}

          {localError && <div role="alert" className="mt-3 rounded-input bg-error/5 px-3 py-2 text-xs text-error">{localError}</div>}

          <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-3 flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted hover:text-text">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? t("knowledge.hideDetails") : t("knowledge.showDetails")}
          </button>
          {expanded && (
            <div className="space-y-3 border-t border-faint pt-3 text-xs leading-5 text-muted">
              <div><span className="font-medium text-text">{t("knowledge.reviewerReason")}:</span> {proposal.reason}</div>
              {proposal.source.session_id && (
                <button type="button" onClick={() => navigate(`/workspace/${encodeURIComponent(cwd)}/session/${proposal.source.session_id}`)} className="min-h-11 rounded-input border border-border px-3 py-2 text-link hover:bg-surface-2">
                  {t("knowledge.openSourceSession")} · {proposal.source.session_id.slice(0, 12)}
                </button>
              )}
              {proposal.related_files.length > 0 && <div><span className="font-medium text-text">{t("knowledge.relatedFiles")}:</span> {proposal.related_files.join(", ")}</div>}
              {proposal.conflicts_with.length > 0 && <div className="flex gap-2 rounded-input bg-warn/10 px-3 py-2 text-warn"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {t("knowledge.conflictsWith")}: {proposal.conflicts_with.join(", ")}</div>}
              {preview && <SafetyPreview data={preview} />}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-faint px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <button type="button" onClick={() => { setEditing(false); setTitle(proposal.title); setSummary(proposal.summary); setOperations(proposal.operations.map((item) => ({ ...item }))); }} className="flex min-h-11 items-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:text-text"><X size={14} /> {t("common.cancel")}</button>
              <button type="button" disabled={busy !== null} onClick={() => void save()} className="flex min-h-11 items-center gap-1.5 rounded-input border border-accent/40 px-3 py-2 text-sm text-accent hover:bg-accent/5 disabled:opacity-50">{busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {t("knowledge.saveChanges")}</button>
            </>
          ) : (
            <button type="button" onClick={() => setEditing(true)} className="flex min-h-11 items-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:text-text"><Pencil size={14} /> {t("knowledge.edit")}</button>
          )}
          {proposal.proposal_type === "file_operation" && (
            <button type="button" disabled={busy !== null} onClick={() => void loadPreview()} className="flex min-h-11 items-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:text-text disabled:opacity-50">
              {busy === "preview" ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />} {t("knowledge.safetyPreview")}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={busy !== null} onClick={() => void decide("reject")} className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-input border border-border px-4 py-2 text-sm text-muted hover:border-error/40 hover:text-error disabled:opacity-50 sm:flex-none">
            {busy === "reject" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} {t("knowledge.reject")}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void decide("accept")} className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-input bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50 sm:flex-none">
            {busy === "accept" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t("knowledge.accept")}
          </button>
        </div>
      </div>
    </article>
  );
}

function OperationList({ operations }: { operations: FileOperation[] }) {
  return (
    <div className="space-y-2 font-mono text-[12px] leading-5">
      {operations.map((operation, index) => (
        <div key={`${operation.type}-${index}`}>
          {operation.type === "mkdir" ? (
            <span className="text-ok">+ mkdir {operation.target}</span>
          ) : (
            <>
              <div className="text-error/80">- {operation.source}</div>
              <div className="text-ok">+ {operation.target}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function SafetyPreview({ data }: { data: Record<string, unknown> }) {
  const collisions = Array.isArray(data.collisions) ? data.collisions as string[] : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings as string[] : [];
  const referenceCount = typeof data.reference_count === "number" ? data.reference_count : 0;
  return (
    <div className={cn("rounded-input border px-3 py-3", collisions.length ? "border-error/30 bg-error/5" : "border-ok/30 bg-ok/5")}>
      <div className="font-medium text-text">{collisions.length ? "Safety checks found blockers" : "Safety checks passed"}</div>
      <div className="mt-1">References to update: {referenceCount}</div>
      {collisions.map((value) => <div key={value} className="mt-1 text-error">• {value}</div>)}
      {warnings.map((value) => <div key={value} className="mt-1 text-warn">• {value}</div>)}
    </div>
  );
}

function KnowledgeTab({ items }: { items: KnowledgeItem[] }) {
  const { t } = useTranslation();
  const groups = groupKnowledgeItems(items);
  if (items.length === 0) return <EmptyState icon={<FileText size={28} />} title={t("knowledge.noKnowledge")} text={t("knowledge.noKnowledgeText")} />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Object.entries(groups).map(([type, rows]) => (
        <section key={type} className="rounded-card border border-border bg-surface p-4 shadow-card">
          <div className="flex items-center justify-between border-b border-faint pb-3">
            <h2 className="font-serif text-lg text-text">{KNOWLEDGE_LABELS[type as keyof typeof KNOWLEDGE_LABELS]}</h2>
            <span className="font-mono text-xs text-muted">{rows.length}</span>
          </div>
          <div className="divide-y divide-faint">
            {rows.map((item) => (
              <article key={item.id} className={cn("py-4", item.status !== "active" && "opacity-55")}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-text">{item.title}</h3>
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted">{item.status}</span>
                </div>
                <p className="mt-1.5 text-sm leading-6 text-muted">{item.summary}</p>
                <div className="mt-2 font-mono text-[10px] text-muted">{item.id} · {item.confidence}</div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FilesTab({
  cwd,
  views,
  policy,
  onRefresh,
  onPolicyChange,
  onError,
}: {
  cwd: string;
  views: LogicalFileViews | null;
  policy: ProjectPolicy | null;
  onRefresh: () => Promise<void>;
  onPolicyChange: (policy: ProjectPolicy) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const openInspector = useUiStore((state) => state.openInspector);
  const [view, setView] = useState<"by_type" | "by_topic" | "by_month">("by_type");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lockedPaths, setLockedPaths] = useState(policy?.locked_paths.join("\n") ?? "");
  const [namingPattern, setNamingPattern] = useState(policy?.naming_pattern ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLockedPaths(policy?.locked_paths.join("\n") ?? "");
    setNamingPattern(policy?.naming_pattern ?? "");
  }, [policy]);

  const savePolicy = async () => {
    setSaving(true);
    onError(null);
    try {
      const updated = await projectKnowledgeApi.updatePolicy(cwd, {
        locked_paths: lockedPaths.split("\n").map((value) => value.trim()).filter(Boolean),
        naming_pattern: namingPattern,
      });
      onPolicyChange(updated);
      setSettingsOpen(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Unable to save file policy");
    } finally {
      setSaving(false);
    }
  };

  if (!views) return <div className="flex items-center justify-center py-16 text-muted"><Loader2 size={20} className="animate-spin" /></div>;
  const groups = views[view];
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1">
          {(["by_type", "by_topic", "by_month"] as const).map((value) => (
            <button key={value} type="button" onClick={() => setView(value)} className={cn("min-h-11 rounded-input px-3 py-2 text-sm", view === value ? "bg-surface-2 font-medium text-text" : "text-muted hover:text-text")}>
              {value === "by_type" ? t("knowledge.byType") : value === "by_topic" ? t("knowledge.byTopic") : t("knowledge.byMonth")}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setSettingsOpen((value) => !value)} className="flex min-h-11 items-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:text-text"><Settings size={14} /> {t("knowledge.policy")}</button>
          <button type="button" onClick={() => void onRefresh()} className="flex min-h-11 items-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:text-text"><RefreshCw size={14} /> {t("knowledge.refresh")}</button>
        </div>
      </div>

      {settingsOpen && policy && (
        <section className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h2 className="flex items-center gap-2 font-serif text-lg text-text"><Lock size={16} className="text-accent" /> {t("knowledge.organizationPolicy")}</h2>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <label className="text-xs font-medium text-muted">
              {t("knowledge.lockedPaths")}
              <textarea value={lockedPaths} onChange={(event) => setLockedPaths(event.target.value)} rows={5} placeholder="data/raw&#10;deliverables/final" className="mt-1 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-sm leading-6 text-text outline-none focus:border-accent" />
            </label>
            <label className="text-xs font-medium text-muted">
              {t("knowledge.namingPattern")}
              <input value={namingPattern} onChange={(event) => setNamingPattern(event.target.value)} className="mt-1 min-h-11 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent" />
              <span className="mt-2 block font-normal leading-5">{t("knowledge.policyHint", { depth: policy.max_directory_depth, count: policy.minimum_files_for_new_category })}</span>
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="button" disabled={saving} onClick={() => void savePolicy()} className="flex min-h-11 items-center gap-2 rounded-input bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {t("knowledge.savePolicy")}</button>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([group, rows]) => (
          <section key={group} className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
            <div className="flex items-center justify-between border-b border-faint px-4 py-3">
              <h2 className="truncate text-sm font-semibold text-text">{group}</h2>
              <span className="font-mono text-xs text-muted">{rows.length}</span>
            </div>
            <div className="divide-y divide-faint">
              {rows.slice(0, 40).map((file) => (
                <button key={file.id} type="button" onClick={() => openInspector({ variant: "file", path: file.path, filename: file.name } as never)} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2">
                  <FileText size={15} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{file.path}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted">{formatFileSize(file.size)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function HistoryTab({
  cwd,
  rows,
  onRefresh,
  onChanged,
  onError,
}: {
  cwd: string;
  rows: Array<Record<string, unknown>>;
  onRefresh: () => Promise<void>;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [undoing, setUndoing] = useState<string | null>(null);
  const undone = new Set(rows.filter((row) => row.event === "file_operation.undone").map((row) => String(row.history_id)));
  const undo = async (historyId: string) => {
    setUndoing(historyId);
    onError(null);
    try {
      await projectKnowledgeApi.undo(cwd, historyId);
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Unable to undo file operation");
    } finally {
      setUndoing(null);
    }
  };
  const restore = async (versionId: string) => {
    setUndoing(versionId);
    onError(null);
    try {
      await projectKnowledgeApi.restoreProjectVersion(cwd, versionId);
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Unable to restore project document version");
    } finally {
      setUndoing(null);
    }
  };
  if (rows.length === 0) return <EmptyState icon={<History size={28} />} title={t("knowledge.historyEmpty")} text={t("knowledge.historyEmptyText")} />;
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><button type="button" onClick={() => void onRefresh()} className="flex min-h-11 items-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:text-text"><RefreshCw size={14} /> {t("knowledge.refresh")}</button></div>
      {rows.map((row, index) => {
        const id = String(row.id || `history-${index}`);
        const event = String(row.event || row.status || "event");
        const created = String(row.created_at || row.finished_at || row.started_at || "");
        const canUndo = event === "file_operation.applied" && !undone.has(id);
        const versionId = event === "project_document.version" && row.version_id ? String(row.version_id) : null;
        return (
          <article key={id} className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-xs text-accent">{event}</div>
              <div className="mt-1 truncate text-sm text-text">{String(row.proposal_id || row.knowledge_id || row.session_id || id)}</div>
              {created && <div className="mt-1 text-xs text-muted">{new Date(created).toLocaleString()}</div>}
            </div>
            {canUndo && (
              <button type="button" disabled={undoing !== null} onClick={() => void undo(id)} className="flex min-h-11 items-center justify-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:border-accent/40 hover:text-text disabled:opacity-50">
                {undoing === id ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} {t("knowledge.undo")}
              </button>
            )}
            {versionId && (
              <button type="button" disabled={undoing !== null} onClick={() => void restore(versionId)} className="flex min-h-11 items-center justify-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:border-accent/40 hover:text-text disabled:opacity-50">
                {undoing === versionId ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} {t("knowledge.restoreVersion")}
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted">{icon}</div>
      <h2 className="mt-4 font-serif text-lg text-text">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{text}</p>
    </div>
  );
}
