import type { ReactNode } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowUpRight, Copy, Crosshair, FileOutput, FileSearch,
  Loader2, MessageSquare, RotateCcw,
} from "lucide-react";
import type { ExecutionRecord } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon";
import type { DetailTab, DisplayLog } from "./run-types";
import { executionCommandText, executionDuration, executionError, executionLabel, formatTimestamp, isProblemExecution } from "./run-formatters";

export interface ExecutionDetailsProps {
  run: ExecutionRecord;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onBack: () => void;
  onCopy: (text: string, message: string) => void;
  onOpenFile: (path: string) => void;
  onOpenArtifact: (artifact: ExecutionRecord["artifacts"][number]) => void;
  onOpenSession?: () => void;
  onLocate?: () => void;
  onReproduce: () => void;
  log?: DisplayLog;
  loadingLog: boolean;
}

export function ExecutionDetails({ run, tab, onTabChange, onBack, onCopy, onOpenFile, onOpenArtifact, onOpenSession, onLocate, onReproduce, log, loadingLog }: ExecutionDetailsProps) {
  const { t } = useTranslation();
  const tabs: DetailTab[] = ["summary", "input", "output", "files", "runtime", "timing"];
  const problem = isProblemExecution(run) ? executionError(run) : "";
  const exitCode = typeof run.result.exit_code === "number" ? run.result.exit_code : undefined;
  return (
    <div className="flex h-full min-h-[540px] w-full flex-col">
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
        <div className="mt-3 flex flex-wrap gap-1.5">
          <DetailAction icon={<RotateCcw size={12} />} label={t("runs.reproduce")} onClick={onReproduce} primary />
          {onLocate && <DetailAction icon={<Crosshair size={12} />} label={t("runs.locateExecution")} onClick={onLocate} />}
          {onOpenSession && <DetailAction icon={<MessageSquare size={12} />} label={t("runs.openSession")} onClick={onOpenSession} />}
          <DetailAction icon={<Copy size={12} />} label={t("runs.copyId")} onClick={() => onCopy(run.execution_id, t("runs.idCopied"))} />
          {executionCommandText(run) && <DetailAction icon={<Copy size={12} />} label={t("runs.copyCommand")} onClick={() => onCopy(executionCommandText(run), t("runs.commandCopied"))} />}
        </div>
        {isProblemExecution(run) && (problem || exitCode !== undefined) && (
          <div className="mt-3 rounded-input border border-error/25 bg-error/5 px-3 py-2 text-[11px] text-error-text">
            <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={12} />{t("runs.errorSummary")}{exitCode !== undefined && <span className="font-normal text-muted">· {t("runs.exitCode", { code: exitCode })}</span>}</div>
            {problem && <div className="mt-1 whitespace-pre-wrap font-mono leading-relaxed">{problem}</div>}
          </div>
        )}
      </div>
      <div className="flex overflow-x-auto border-b border-border px-2" role="tablist" aria-label={t("runs.detailTabs")}>
        {tabs.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => onTabChange(item)} className={cn("shrink-0 border-b-2 px-3 py-2.5 text-[11px] transition-colors", tab === item ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>{t(`runs.tab.${item}`)}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "summary" && <SummaryDetails run={run} />}
        {tab === "input" && <JsonBlock value={run.request} empty={t("runs.noInput")} />}
        {tab === "output" && <div className="space-y-4"><DetailSection title={t("runs.result")}><JsonBlock value={run.result} empty={t("runs.noResult")} /></DetailSection><DetailSection title={t("runs.log")}>{loadingLog ? <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{t("common.loading")}</div> : <div>{log && !log.complete && <p className="mb-2 text-[10px] text-muted">{t("runs.logPreview")}</p>}<pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text">{log?.text ?? t("runs.noLog")}</pre></div>}</DetailSection></div>}
        {tab === "files" && <FileDetails run={run} onOpenFile={onOpenFile} onOpenArtifact={onOpenArtifact} />}
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

function FileDetails({ run, onOpenFile, onOpenArtifact }: { run: ExecutionRecord; onOpenFile: (path: string) => void; onOpenArtifact: (artifact: ExecutionRecord["artifacts"][number]) => void }) {
  const { t } = useTranslation();
  return <div className="space-y-5"><FileList title={t("runs.filesRead")} icon={<FileSearch size={13} />} files={run.files.read} empty={t("runs.noFilesRead")} onOpen={onOpenFile} /><FileList title={t("runs.filesWritten")} icon={<FileOutput size={13} />} files={run.files.written} empty={t("runs.noFilesWritten")} onOpen={onOpenFile} /><DetailSection title={t("runs.artifacts")}>{run.artifacts.length === 0 ? <p className="text-xs text-muted">{t("runs.noArtifacts")}</p> : <div className="space-y-2">{run.artifacts.map((artifact) => <button type="button" onClick={() => onOpenArtifact(artifact)} key={`${artifact.artifact_id}:${artifact.version}:${artifact.relation}`} className="group flex w-full items-center gap-3 rounded-input border border-border bg-surface-2 px-3 py-2 text-left hover:border-accent-border hover:bg-accent-soft"><span className="min-w-0 flex-1"><span className="block truncate font-mono text-[11px] text-text">{artifact.artifact_id}</span><span className="mt-1 block text-[10px] text-muted">{artifact.relation} · v{artifact.version}</span></span><ArrowUpRight size={13} className="shrink-0 text-muted group-hover:text-accent" /></button>)}</div>}</DetailSection></div>;
}

function FileList({ title, icon, files, empty, onOpen }: { title: string; icon: ReactNode; files: ExecutionRecord["files"]["read"]; empty: string; onOpen: (path: string) => void }) {
  return <DetailSection title={title} icon={icon}>{files.length === 0 ? <p className="text-xs text-muted">{empty}</p> : <div className="space-y-2">{files.map((file, index) => <button type="button" onClick={() => onOpen(file.path)} key={`${file.path}:${index}`} className="group flex w-full items-center gap-3 rounded-input border border-border bg-surface-2 px-3 py-2 text-left hover:border-accent-border hover:bg-accent-soft"><span className="min-w-0 flex-1"><span className="block break-all font-mono text-[11px] text-text">{file.path}</span><span className="mt-1 block text-[10px] text-muted">{file.detection}</span></span><ArrowUpRight size={13} className="shrink-0 text-muted group-hover:text-accent" /></button>)}</div>}</DetailSection>;
}

function TimingDetails({ run }: { run: ExecutionRecord }) {
  const { t } = useTranslation();
  return <dl className="runs-detail-fields grid gap-x-3 gap-y-3 text-xs"><DetailTerm>{t("runs.field.created")}</DetailTerm><DetailValue mono>{formatTimestamp(run.created_at)}</DetailValue><DetailTerm>{t("runs.field.started")}</DetailTerm><DetailValue mono>{formatTimestamp(run.started_at)}</DetailValue><DetailTerm>{t("runs.field.ended")}</DetailTerm><DetailValue mono>{formatTimestamp(run.ended_at)}</DetailValue><DetailTerm>{t("runs.duration")}</DetailTerm><DetailValue mono>{executionDuration(run, t("runs.running"))}</DetailValue></dl>;
}

function DetailSection({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) { return <section><h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{icon}{title}</h3>{children}</section>; }
function DetailAction({ icon, label, onClick, primary = false }: { icon: ReactNode; label: string; onClick: () => void; primary?: boolean }) { return <button type="button" onClick={onClick} className={cn("flex min-h-7 items-center gap-1.5 rounded-input border px-2.5 text-[10px] transition-colors", primary ? "border-accent-border bg-accent-soft text-accent hover:bg-accent/10" : "border-border bg-surface text-muted hover:border-border-strong hover:text-text")}>{icon}{label}</button>; }
function DetailTerm({ children }: { children: ReactNode }) { return <dt className="text-muted">{children}</dt>; }
function DetailValue({ children, mono = false }: { children: ReactNode; mono?: boolean }) { return <dd className={cn("min-w-0 break-all text-text", mono && "font-mono text-[11px]")}>{children}</dd>; }
function JsonBlock({ value, empty }: { value: Record<string, unknown>; empty: string }) { return Object.keys(value).length === 0 ? <p className="text-xs text-muted">{empty}</p> : <pre className="max-h-[440px] overflow-auto whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text">{JSON.stringify(value, null, 2)}</pre>; }
