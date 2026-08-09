import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Pencil, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/ui";
import { KNOWLEDGE_LABELS, projectKnowledgeApi, type FileOperation, type Proposal } from "../../lib/knowledge";
import { OperationList } from "./OperationList";
import { SafetyPreview } from "./SafetyPreview";

export function ProposalCard({
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
      setLocalError(cause instanceof Error ? cause.message : t("knowledge.proposalSaveError"));
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
      setLocalError(cause instanceof Error ? cause.message : t("knowledge.proposalUpdateError"));
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
      setLocalError(cause instanceof Error ? cause.message : t("knowledge.proposalPreviewError"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={cn("ui-card-flat rounded-card transition-colors", selected && "border-accent/50")}>
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
            <span className="text-[11px] text-muted">{t("knowledge.confidenceLevel", { level: proposal.confidence })}</span>
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
                        <input aria-label={t("knowledge.sourcePath")} value={operation.source || ""} onChange={(event) => setOperations((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, source: event.target.value } : item))} className="min-h-11 rounded-input border border-border bg-surface px-3 text-sm text-text" />
                      )}
                      <input aria-label={t("knowledge.targetPath")} value={operation.target} onChange={(event) => setOperations((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, target: event.target.value } : item))} className="min-h-11 rounded-input border border-border bg-surface px-3 text-sm text-text" />
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

          <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-3 flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-text">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? t("knowledge.hideDetails") : t("knowledge.showDetails")}
          </button>
          {expanded && (
            <div className="space-y-3 border-t border-faint pt-3 text-xs leading-5 text-muted">
              <div><span className="font-medium text-text">{t("knowledge.reviewerReason")}:</span> {proposal.reason}</div>
              {proposal.source.session_id && (
                <button type="button" onClick={() => navigate(`/workspace/${encodeURIComponent(cwd)}/session/${proposal.source.session_id}`)} className="min-h-11 rounded-input border border-border px-3 py-2 text-sm text-link hover:bg-surface-2">
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
