import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, ArrowLeft, ArrowUpRight, Ban, Check, CircleDashed,
  Clock3, Loader2, X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ExecutionRecord, ExecutionsInspector as ExecutionsInspectorData } from "../../types/thread";
import { sessionRunsQuery } from "../../lib/runs";
import { subscribeExecutionInvalidation } from "../../lib/runs/execution-events";
import { timeAgo } from "../../lib/shared";

export function ExecutionInspector({ data, onClose }: { data: ExecutionsInspectorData; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: runs = [], isFetching } = useQuery(sessionRunsQuery(data.cwd, data.sessionId));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => runs.find((run) => run.execution_id === selectedId), [runs, selectedId]);

  useEffect(() => subscribeExecutionInvalidation(data.cwd), [data.cwd]);
  useEffect(() => {
    if (selectedId && !runs.some((run) => run.execution_id === selectedId)) setSelectedId(null);
  }, [runs, selectedId]);

  const openAll = (executionId?: string) => {
    onClose();
    const root = `/workspace/${encodeURIComponent(data.cwd)}/runs`;
    navigate(executionId ? `${root}?execution=${encodeURIComponent(executionId)}` : root);
  };

  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface">
        <div className="border-b border-border px-4 py-3">
          <button type="button" onClick={() => setSelectedId(null)} className="mb-3 flex items-center gap-1.5 text-[11px] text-muted hover:text-text">
            <ArrowLeft size={13} />{t("runs.backToLedger")}
          </button>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StatusIcon status={selected.status} />
                <h2 className="truncate font-mono text-xs text-text">{executionLabel(selected)}</h2>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-muted">
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-accent">{selected.surface}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5">{t(`runs.kind.${selected.kind}`)}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5">{t(`runs.status.${selected.status}`)}</span>
              </div>
            </div>
            <span className="shrink-0 font-mono text-[10px] text-muted">{duration(selected, t("runs.running"))}</span>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-xs">
          <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-muted">{t("runs.field.producer")}</dt><dd className="break-all text-text">{selected.producer}</dd>
            <dt className="text-muted">ID</dt><dd className="break-all font-mono text-[10px] text-text">{selected.execution_id}</dd>
            <dt className="text-muted">{t("runs.duration")}</dt><dd className="text-text">{duration(selected, t("runs.running"))}</dd>
          </dl>
          <JsonSection title={t("runs.tab.input")} value={selected.request} empty={t("runs.noInput")} />
          <JsonSection title={t("runs.tab.output")} value={selected.result} empty={t("runs.noResult")} />
          {(selected.files.read.length > 0 || selected.files.written.length > 0) && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold text-muted">{t("runs.tab.files")}</h3>
              <div className="space-y-1 font-mono text-[10px] text-text">
                {[...selected.files.read, ...selected.files.written].map((file, index) => <div key={`${file.path}:${index}`} className="break-all rounded bg-surface-2 px-2 py-1.5">{file.path}</div>)}
              </div>
            </section>
          )}
        </div>
        <div className="border-t border-border p-3">
          <button type="button" onClick={() => openAll(selected.execution_id)} className="flex w-full items-center justify-center gap-1.5 rounded-input border border-border bg-surface-2 px-3 py-2 text-[11px] font-medium text-text hover:border-accent-border hover:bg-accent-soft">
            {t("runs.openFullRecord")}<ArrowUpRight size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><Activity size={15} className="text-accent" /><h2 className="text-sm font-medium text-text">{t("runs.sessionTitle")}</h2></div>
          <p className="mt-1 truncate text-[10px] text-muted">{t("runs.sessionCount", { count: runs.length })}</p>
        </div>
        {isFetching && <Loader2 size={14} className="shrink-0 animate-spin text-muted" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.length === 0 ? (
          <div className="px-6 py-16 text-center"><Activity size={28} className="mx-auto mb-3 text-muted/30" /><p className="text-xs text-muted">{t("runs.sessionEmpty")}</p></div>
        ) : runs.map((run) => (
          <button key={run.execution_id} type="button" onClick={() => setSelectedId(run.execution_id)} className="flex w-full items-start gap-2.5 border-b border-faint px-4 py-3 text-left hover:bg-surface-2/70">
            <StatusIcon status={run.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[11px] text-text">{executionLabel(run)}</span>
              <span className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted"><span className="text-accent">{run.surface}</span><span>{t(`runs.kind.${run.kind}`)}</span><span>{timeAgo(run.started_at ?? run.created_at)}</span></span>
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted">{duration(run, t("runs.running"))}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-border p-3">
        <button type="button" onClick={() => openAll()} className="flex w-full items-center justify-center gap-1.5 rounded-input px-3 py-2 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-text">
          {t("runs.viewAll")}<ArrowUpRight size={13} />
        </button>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: ExecutionRecord["status"] }) {
  if (status === "succeeded") return <Check size={14} className="mt-0.5 shrink-0 text-ok" />;
  if (status === "running") return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-accent" />;
  if (status === "pending") return <CircleDashed size={14} className="mt-0.5 shrink-0 text-muted" />;
  if (status === "timed_out") return <Clock3 size={14} className="mt-0.5 shrink-0 text-warn" />;
  if (status === "cancelled") return <Ban size={14} className="mt-0.5 shrink-0 text-muted" />;
  if (status === "interrupted" || status === "lost") return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />;
  return <X size={14} className="mt-0.5 shrink-0 text-error" />;
}

function executionLabel(run: ExecutionRecord): string {
  if (run.kind === "kernel_cell") {
    const notebook = typeof run.request.notebook_id === "string" ? run.request.notebook_id : "default";
    const code = typeof run.request.code === "string" ? run.request.code.trim().split("\n")[0] : "";
    return `${notebook} · ${code || run.surface}`;
  }
  return run.request.command?.join(" ") || String(run.request.tool || run.execution_id);
}

function duration(run: ExecutionRecord, running: string): string {
  if (!run.started_at) return "—";
  if (!run.ended_at) return running;
  const milliseconds = Math.max(0, Date.parse(run.ended_at) - Date.parse(run.started_at));
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function JsonSection({ title, value, empty }: { title: string; value: Record<string, unknown>; empty: string }) {
  return <section><h3 className="mb-2 text-[11px] font-semibold text-muted">{title}</h3>{Object.keys(value).length === 0 ? <p className="text-xs text-muted">{empty}</p> : <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[10px] leading-relaxed text-text">{JSON.stringify(value, null, 2)}</pre>}</section>;
}
