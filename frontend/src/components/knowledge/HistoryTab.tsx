import { useEffect, useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { projectKnowledgeApi } from "../../lib/knowledge";
import { useProjectTimeline } from "../../lib/knowledge";
import { EmptyState } from "./EmptyState";

export function HistoryTab({
  cwd,
  onChanged,
  onError,
}: {
  cwd: string;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [undoing, setUndoing] = useState<string | null>(null);

  const timelineRead = useProjectTimeline(cwd);
  const rows = timelineRead.data?.timeline ?? [];
  const loadError = timelineRead.error;
  useEffect(() => {
    if (loadError) onError(loadError instanceof Error ? loadError.message : t("knowledge.historyError"));
  }, [loadError, onError, t]);

  const undone = new Set(rows.filter((row) => row.event === "file_operation.undone").map((row) => String(row.history_id)));
  const undo = async (historyId: string) => {
    setUndoing(historyId);
    onError(null);
    try {
      await projectKnowledgeApi.undo(cwd, historyId);
      await Promise.all([onChanged(), timelineRead.refetch()]);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t("knowledge.undoError"));
    } finally {
      setUndoing(null);
    }
  };
  const restore = async (versionId: string) => {
    setUndoing(versionId);
    onError(null);
    try {
      await projectKnowledgeApi.restoreProjectVersion(cwd, versionId);
      await Promise.all([onChanged(), timelineRead.refetch()]);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t("knowledge.restoreError"));
    } finally {
      setUndoing(null);
    }
  };
  if (rows.length === 0) return <EmptyState icon={<History size={28} />} title={t("knowledge.historyEmpty")} text={t("knowledge.historyEmptyText")} />;
  return (
    <div className="space-y-3">
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
