import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Ban, Check, Circle, CircleDashed, Clock3, FileOutput,
  FileSearch, Loader2, Play, Search, X,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import type { ExecutionRecord } from "../../types/thread";
import { cn } from "../../lib/ui";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useTranslation } from "react-i18next";
import { timeAgo } from "../../lib/shared";
import { queryClient } from "../../lib/client/query-client";
import { runLogQuery, runsQuery } from "../../lib/runs";
import { useFeedback } from "../../components/feedback/feedback-context";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";

type DetailTab = "summary" | "input" | "output" | "files" | "runtime" | "timing";
type KindFilter = "all" | ExecutionRecord["kind"];
type StatusFilter = "all" | ExecutionRecord["status"];

const KINDS: ExecutionRecord["kind"][] = ["tool", "kernel_cell", "job", "research_agent", "research_evaluation"];
const STATUSES: ExecutionRecord["status"][] = ["pending", "running", "succeeded", "failed", "timed_out", "cancelled", "interrupted", "lost"];
const EMPTY_RUNS: ExecutionRecord[] = [];

export function RunsPage() {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const [compactDetailOpen, setCompactDetailOpen] = useState(() => searchParams.has("execution"));
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [loadingLogs, setLoadingLogs] = useState<Record<string, boolean>>({});

  const runsResult = useQuery(runsQuery(workspaceCwd));
  const runs = runsResult.data ?? EMPTY_RUNS;
  const loading = runsResult.isFetching;
  const selectedId = searchParams.get("execution");

  const filteredRuns = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return runs.filter((run) => {
      if (kind !== "all" && run.kind !== kind) return false;
      if (status !== "all" && run.status !== status) return false;
      return !needle || executionSearchText(run).toLocaleLowerCase().includes(needle);
    });
  }, [kind, runs, search, status]);

  const selected = filteredRuns.find((run) => run.execution_id === selectedId);

  useEffect(() => {
    const first = filteredRuns[0];
    if (!first || selected) return;
    const next = new URLSearchParams(searchParams);
    next.set("execution", first.execution_id);
    setSearchParams(next, { replace: true });
  }, [filteredRuns, searchParams, selected, setSearchParams]);

  const runsError = runsResult.error;
  useEffect(() => {
    if (runsError) toast(runsError instanceof Error ? runsError.message : t("runs.loadError"), "error");
  }, [runsError, t, toast]);

  useEffect(() => {
    if (!selected || detailTab !== "output" || logs[selected.execution_id] !== undefined || loadingLogs[selected.execution_id]) return;
    const executionId = selected.execution_id;
    setLoadingLogs((current) => ({ ...current, [executionId]: true }));
    void queryClient.fetchQuery(runLogQuery(workspaceCwd, executionId)).then((data) => {
      const log = [data.stdout, data.stderr].filter(Boolean).join("\n");
      setLogs((current) => ({ ...current, [executionId]: log || t("runs.noLog") }));
    }).catch((error: unknown) => {
      setLogs((current) => ({ ...current, [executionId]: t("runs.logLoadFailed") }));
      toast(error instanceof Error ? error.message : t("runs.logError"), "error");
    }).finally(() => {
      setLoadingLogs((current) => ({ ...current, [executionId]: false }));
    });
  }, [detailTab, loadingLogs, logs, selected, t, toast, workspaceCwd]);

  const selectExecution = (executionId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("execution", executionId);
    setSearchParams(next);
    setDetailTab("summary");
    setCompactDetailOpen(true);
  };

  return (
    <WorkspacePage>
      <WorkspacePageHeader
        title={t("runs.title")}
        description={filteredRuns.length === runs.length
          ? t("runs.count", { count: runs.length })
          : t("runs.filteredCount", { visible: filteredRuns.length, total: runs.length })}
        actions={<WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={() => void runsResult.refetch()} />}
      />

      <div className="runs-toolbar mt-5 flex flex-wrap items-center gap-2 rounded-card border border-border p-2">
        <label className="relative min-w-[220px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            aria-label={t("runs.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("runs.searchPlaceholder")}
            className="min-h-9 w-full rounded-input border border-border bg-surface pl-9 pr-3 text-xs text-text outline-none transition-colors placeholder:text-muted focus:border-accent"
          />
        </label>
        <select aria-label={t("runs.kindFilter")} value={kind} onChange={(event) => setKind(event.target.value as KindFilter)} className="min-h-9 rounded-input border border-border bg-surface px-3 text-xs text-text outline-none focus:border-accent">
          <option value="all">{t("runs.allKinds")}</option>
          {KINDS.map((item) => <option key={item} value={item}>{t(`runs.kind.${item}`)}</option>)}
        </select>
        <select aria-label={t("runs.statusFilter")} value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} className="min-h-9 rounded-input border border-border bg-surface px-3 text-xs text-text outline-none focus:border-accent">
          <option value="all">{t("runs.allStatuses")}</option>
          {STATUSES.map((item) => <option key={item} value={item}>{t(`runs.status.${item}`)}</option>)}
        </select>
      </div>

      <div className="mt-4">
        {loading && runs.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted"><Loader2 size={18} className="mx-auto mb-2 animate-spin" />{t("common.loading")}</div>
        ) : runs.length === 0 ? (
          <EmptyState icon={<Play size={40} />} title={t("runs.empty")} hint={t("runs.emptyHint")} />
        ) : filteredRuns.length === 0 ? (
          <EmptyState icon={<FileSearch size={36} />} title={t("runs.noMatches")} hint={t("runs.noMatchesHint")} />
        ) : (
          <div data-testid="runs-workbench" data-compact-detail={compactDetailOpen ? "true" : "false"} className="runs-ledger-layout runs-workbench grid min-h-[540px] overflow-hidden rounded-card border border-border bg-surface">
            <section aria-label={t("runs.ledger")} className="runs-ledger-pane min-w-0 border-b border-border lg:border-b-0 lg:border-r">
              <div className="runs-ledger-columns grid items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
                <span>#</span><span>{t("runs.execution")}</span><span>{t("runs.duration")}</span>
              </div>
              <div className="max-h-[620px] overflow-y-auto">
                {filteredRuns.map((run, index) => <ExecutionRow key={run.execution_id} run={run} index={index + 1} selected={run.execution_id === selected?.execution_id} onClick={() => selectExecution(run.execution_id)} />)}
              </div>
            </section>
            <section aria-label={t("runs.details")} className="runs-detail-pane min-w-0 bg-bg/40">
              {selected && <ExecutionDetails run={selected} tab={detailTab} onTabChange={setDetailTab} onBack={() => setCompactDetailOpen(false)} log={logs[selected.execution_id]} loadingLog={Boolean(loadingLogs[selected.execution_id])} />}
            </section>
          </div>
        )}
      </div>
    </WorkspacePage>
  );
}

function ExecutionRow({ run, index, selected, onClick }: { run: ExecutionRecord; index: number; selected: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const outputs = outputCount(run);
  return (
    <button type="button" onClick={onClick} aria-current={selected ? "true" : undefined} className={cn("runs-ledger-columns runs-ledger-row grid w-full items-start gap-2 border-b border-faint px-3 py-3 text-left transition-colors last:border-b-0", selected && "runs-ledger-row-selected")}>
      <span className="pt-0.5 text-[10px] tabular-nums text-muted">{index}</span>
      <span className="min-w-0">
        <span className="flex items-center gap-2"><ExecutionStatusIcon status={run.status} /><span className="truncate font-mono text-[12px] text-text">{executionLabel(run)}</span></span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-[10px] text-muted">
          <span className="font-semibold uppercase tracking-wide text-accent">{run.surface}</span><span>{t(`runs.kind.${run.kind}`)}</span><span>{timeAgo(run.started_at ?? run.created_at)}</span>
          {outputs > 0 && <span>{t("runs.outputCount", { count: outputs })}</span>}
        </span>
      </span>
      <span className="whitespace-nowrap pt-0.5 font-mono text-[10px] tabular-nums text-muted">{executionDuration(run, t("runs.running"))}</span>
    </button>
  );
}

function ExecutionDetails({ run, tab, onTabChange, onBack, log, loadingLog }: { run: ExecutionRecord; tab: DetailTab; onTabChange: (tab: DetailTab) => void; onBack: () => void; log?: string; loadingLog: boolean }) {
  const { t } = useTranslation();
  const tabs: DetailTab[] = ["summary", "input", "output", "files", "runtime", "timing"];
  return (
    <div className="flex h-full min-h-[540px] flex-col">
      <div className="runs-detail-header border-b border-border px-4 py-4">
        <button type="button" onClick={onBack} className="runs-detail-back mb-3 items-center gap-1.5 text-[11px] text-muted hover:text-text">
          <ArrowLeft size={13} />{t("runs.backToLedger")}
        </button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><ExecutionStatusIcon status={run.status} size={16} /><h2 className="truncate font-mono text-sm text-text">{executionLabel(run)}</h2></div>
            <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-muted">
              <span className="rounded bg-surface-2 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-accent">{run.surface}</span>
              <span className="rounded bg-surface-2 px-1.5 py-0.5">{t(`runs.kind.${run.kind}`)}</span>
              <span className="rounded bg-surface-2 px-1.5 py-0.5">{t(`runs.status.${run.status}`)}</span>
            </div>
          </div>
          <span className="shrink-0 font-mono text-[10px] text-muted">{executionDuration(run, t("runs.running"))}</span>
        </div>
        <div className="mt-3 break-all font-mono text-[10px] text-muted">{run.execution_id}</div>
      </div>
      <div className="flex overflow-x-auto border-b border-border px-2" role="tablist" aria-label={t("runs.detailTabs")}>
        {tabs.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => onTabChange(item)} className={cn("shrink-0 border-b-2 px-3 py-2.5 text-[11px] transition-colors", tab === item ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>{t(`runs.tab.${item}`)}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "summary" && <SummaryDetails run={run} />}
        {tab === "input" && <JsonBlock value={run.request} empty={t("runs.noInput")} />}
        {tab === "output" && <div className="space-y-4"><DetailSection title={t("runs.result")}><JsonBlock value={run.result} empty={t("runs.noResult")} /></DetailSection><DetailSection title={t("runs.log")}>{loadingLog ? <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{t("common.loading")}</div> : <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text">{log ?? t("runs.noLog")}</pre>}</DetailSection></div>}
        {tab === "files" && <FileDetails run={run} />}
        {tab === "runtime" && <JsonBlock value={run.runtime} empty={t("runs.noRuntime")} />}
        {tab === "timing" && <TimingDetails run={run} />}
      </div>
    </div>
  );
}

function SummaryDetails({ run }: { run: ExecutionRecord }) {
  const { t } = useTranslation();
  return <div className="space-y-5"><dl className="runs-detail-fields grid gap-x-3 gap-y-2 text-xs"><DetailTerm>{t("runs.field.status")}</DetailTerm><DetailValue>{t(`runs.status.${run.status}`)}</DetailValue><DetailTerm>{t("runs.field.kind")}</DetailTerm><DetailValue>{t(`runs.kind.${run.kind}`)}</DetailValue><DetailTerm>{t("runs.field.surface")}</DetailTerm><DetailValue>{run.surface}</DetailValue><DetailTerm>{t("runs.field.producer")}</DetailTerm><DetailValue>{run.producer}</DetailValue><DetailTerm>{t("runs.field.workspace")}</DetailTerm><DetailValue mono>{run.workspace_id}</DetailValue><DetailTerm>{t("runs.duration")}</DetailTerm><DetailValue>{executionDuration(run, t("runs.running"))}</DetailValue></dl><DetailSection title={t("runs.correlation")}><JsonBlock value={run.correlation} empty={t("runs.noCorrelation")} /></DetailSection></div>;
}

function FileDetails({ run }: { run: ExecutionRecord }) {
  const { t } = useTranslation();
  return <div className="space-y-5"><FileList title={t("runs.filesRead")} icon={<FileSearch size={13} />} files={run.files.read} empty={t("runs.noFilesRead")} /><FileList title={t("runs.filesWritten")} icon={<FileOutput size={13} />} files={run.files.written} empty={t("runs.noFilesWritten")} /><DetailSection title={t("runs.artifacts")}>{run.artifacts.length === 0 ? <p className="text-xs text-muted">{t("runs.noArtifacts")}</p> : <div className="space-y-2">{run.artifacts.map((artifact) => <div key={`${artifact.artifact_id}:${artifact.version}:${artifact.relation}`} className="rounded-input border border-border bg-surface-2 px-3 py-2"><div className="font-mono text-[11px] text-text">{artifact.artifact_id}</div><div className="mt-1 text-[10px] text-muted">{artifact.relation} · v{artifact.version}</div></div>)}</div>}</DetailSection></div>;
}

function FileList({ title, icon, files, empty }: { title: string; icon: ReactNode; files: ExecutionRecord["files"]["read"]; empty: string }) {
  return <DetailSection title={title} icon={icon}>{files.length === 0 ? <p className="text-xs text-muted">{empty}</p> : <div className="space-y-2">{files.map((file, index) => <div key={`${file.path}:${index}`} className="rounded-input border border-border bg-surface-2 px-3 py-2"><div className="break-all font-mono text-[11px] text-text">{file.path}</div><div className="mt-1 text-[10px] text-muted">{file.detection}</div></div>)}</div>}</DetailSection>;
}

function TimingDetails({ run }: { run: ExecutionRecord }) {
  const { t } = useTranslation();
  return <dl className="runs-detail-fields grid gap-x-3 gap-y-3 text-xs"><DetailTerm>{t("runs.field.created")}</DetailTerm><DetailValue mono>{formatTimestamp(run.created_at)}</DetailValue><DetailTerm>{t("runs.field.started")}</DetailTerm><DetailValue mono>{formatTimestamp(run.started_at)}</DetailValue><DetailTerm>{t("runs.field.ended")}</DetailTerm><DetailValue mono>{formatTimestamp(run.ended_at)}</DetailValue><DetailTerm>{t("runs.duration")}</DetailTerm><DetailValue mono>{executionDuration(run, t("runs.running"))}</DetailValue></dl>;
}

function DetailSection({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) { return <section><h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{icon}{title}</h3>{children}</section>; }
function DetailTerm({ children }: { children: ReactNode }) { return <dt className="text-muted">{children}</dt>; }
function DetailValue({ children, mono = false }: { children: ReactNode; mono?: boolean }) { return <dd className={cn("min-w-0 break-all text-text", mono && "font-mono text-[11px]")}>{children}</dd>; }
function JsonBlock({ value, empty }: { value: Record<string, unknown>; empty: string }) { return Object.keys(value).length === 0 ? <p className="text-xs text-muted">{empty}</p> : <pre className="max-h-[440px] overflow-auto whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text">{JSON.stringify(value, null, 2)}</pre>; }
function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) { return <div className="py-16 text-center"><div className="mx-auto mb-3 w-fit text-muted/30">{icon}</div><p className="text-sm text-muted">{title}</p><p className="mt-1 text-xs text-muted">{hint}</p></div>; }

function ExecutionStatusIcon({ status, size = 14 }: { status: ExecutionRecord["status"]; size?: number }) {
  if (status === "succeeded") return <Check size={size} className="shrink-0 text-ok" aria-label={status} />;
  if (status === "running") return <Loader2 size={size} className="shrink-0 animate-spin text-accent" aria-label={status} />;
  if (status === "pending") return <CircleDashed size={size} className="shrink-0 text-muted" aria-label={status} />;
  if (status === "timed_out") return <Clock3 size={size} className="shrink-0 text-warn" aria-label={status} />;
  if (status === "cancelled") return <Ban size={size} className="shrink-0 text-muted" aria-label={status} />;
  if (status === "interrupted" || status === "lost") return <AlertTriangle size={size} className="shrink-0 text-warn" aria-label={status} />;
  if (status === "failed") return <X size={size} className="shrink-0 text-error" aria-label={status} />;
  return <Circle size={size} className="shrink-0 text-muted" aria-label={status} />;
}

function executionLabel(run: ExecutionRecord): string {
  if (run.kind === "kernel_cell") {
    const notebook = typeof run.request.notebook_id === "string" ? run.request.notebook_id : "default";
    const code = typeof run.request.code === "string" ? run.request.code.trim().split("\n")[0] : "";
    return `${notebook} · ${code || run.surface}`;
  }
  return run.request.command?.join(" ") || String(run.request.tool || run.execution_id);
}

function executionSearchText(run: ExecutionRecord): string { return [run.execution_id, run.kind, run.surface, run.status, run.producer, executionLabel(run), ...run.files.read.map((file) => file.path), ...run.files.written.map((file) => file.path)].join("\n"); }
function outputCount(run: ExecutionRecord): number { return Math.max(run.files.written.length, run.artifacts.filter((artifact) => artifact.relation === "output").length); }

function executionDuration(run: ExecutionRecord, runningLabel: string): string {
  if (!run.ended_at && ["pending", "running"].includes(run.status)) return runningLabel;
  const start = Date.parse(run.started_at ?? run.created_at);
  const end = run.ended_at ? Date.parse(run.ended_at) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const milliseconds = Math.max(0, end - start);
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
