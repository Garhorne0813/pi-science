import { useEffect, useRef, type ReactNode } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowUpRight, Copy, Crosshair, FileOutput, FileSearch,
  Loader2, MessageSquare, RotateCcw,
} from "lucide-react";
import type { ExecutionRecord } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon";
import type { DetailTab, DisplayLog } from "./run-types";
import { executionCommandText, executionDuration, executionError, executionLabel, executionShortLabel, formatTimestamp, isProblemExecution } from "./run-formatters";

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
  sessionTitle?: string;
}

export function ExecutionDetails({ run, tab, onTabChange, onBack, onCopy, onOpenFile, onOpenArtifact, onOpenSession, onLocate, onReproduce, log, loadingLog, sessionTitle }: ExecutionDetailsProps) {
  const { t } = useTranslation();
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The responsive Back action has a box only in the visible narrow detail pane.
    if (backRef.current?.getClientRects().length) backRef.current.focus();
  }, [run.execution_id]);
  const tabs: DetailTab[] = ["summary", "input", "output", "files", "runtime", "timing"];
  const problem = isProblemExecution(run) ? executionError(run) : "";
  const exitCode = typeof run.result.exit_code === "number" ? run.result.exit_code : undefined;
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="runs-detail-header shrink-0 border-b border-border px-4 py-4">
        <button ref={backRef} type="button" onClick={onBack} className="runs-detail-back mb-3 items-center gap-1.5 text-[13px] text-muted hover:text-text">
          <ArrowLeft size={13} />{t("runs.backToLedger")}
        </button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><ExecutionStatusIcon status={run.status} size={16} /><h2 title={executionLabel(run)} className="line-clamp-2 break-all text-base font-semibold leading-6 text-text">{executionShortLabel(run)}</h2></div>
            <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-muted">
              <span className="rounded bg-surface-2 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-text">{run.surface}</span>
              <span className="rounded bg-surface-2 px-1.5 py-0.5">{t(`runs.kind.${run.kind}`)}</span>
              <span className="rounded bg-surface-2 px-1.5 py-0.5">{t(`runs.status.${run.status}`)}</span>
            </div>
          </div>
          <span className="shrink-0 font-mono text-xs text-muted">{executionDuration(run, t("runs.running"))}</span>
        </div>
        <p className="mt-2 truncate text-xs text-muted" title={run.correlation.session_id}>{sessionTitle || run.correlation.session_id || t("runs.unassociated")} · {formatTimestamp(run.started_at ?? run.created_at)}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {onLocate && <DetailAction icon={<Crosshair size={12} />} label={t("runs.locateExecution")} onClick={onLocate} />}
          {onOpenSession && <DetailAction icon={<MessageSquare size={12} />} label={t("runs.openSession")} onClick={onOpenSession} />}
          <DetailAction icon={<Copy size={12} />} label={t("runs.copyId")} onClick={() => onCopy(run.execution_id, t("runs.idCopied"))} />
          {executionCommandText(run) && <DetailAction icon={<Copy size={12} />} label={t("runs.copyCommand")} onClick={() => onCopy(executionCommandText(run), t("runs.commandCopied"))} />}
        </div>
        {isProblemExecution(run) && (problem || exitCode !== undefined) && (
          <div className="mt-3 rounded-input border border-error/25 bg-error/5 px-3 py-2 text-[13px] text-error-text">
            <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={12} />{t("runs.errorSummary")}{exitCode !== undefined && <span className="font-normal text-muted">· {t("runs.exitCode", { code: exitCode })}</span>}</div>
            {problem && <div className="mt-1 whitespace-pre-wrap font-mono leading-relaxed">{problem}</div>}
          </div>
        )}
      </div>
      <div className="flex shrink-0 overflow-x-auto border-b border-border px-2" role="tablist" aria-label={t("runs.detailTabs")}>
        {tabs.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => onTabChange(item)} className={cn("shrink-0 border-b-2 px-3 py-2.5 text-[13px] transition-colors", tab === item ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>{t(`runs.tab.${item}`)}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "summary" && <SummaryDetails run={run} onOpenFile={onOpenFile} onOpenArtifact={onOpenArtifact} />}
        {tab === "input" && <div className="space-y-4"><InputDetails run={run} /><FileList title={t("runs.filesRead")} icon={<FileSearch size={14} />} files={run.files.read} empty={t("runs.noFilesRead")} onOpen={onOpenFile} /><RawRecord value={run.request} empty={t("runs.noInput")} /></div>}
        {tab === "output" && <div className="space-y-4"><DetailSection title={t("runs.log")}>{loadingLog ? <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{t("common.loading")}</div> : <div>{log && !log.complete && <p className="mb-2 text-xs text-muted">{t("runs.logPreview")}</p>}<pre tabIndex={0} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-input border border-border bg-surface-2 p-3 font-mono text-[13px] leading-relaxed text-text">{log?.text ?? t("runs.noLog")}</pre></div>}</DetailSection><RawRecord value={run.result} empty={t("runs.noResult")} /></div>}
        {tab === "files" && <FileDetails run={run} onOpenFile={onOpenFile} onOpenArtifact={onOpenArtifact} />}
        {tab === "runtime" && <div className="space-y-4"><dl className="runs-detail-fields grid gap-2 text-xs">{Object.entries(run.runtime).filter(([, value]) => typeof value === "string" || typeof value === "number").map(([key, value]) => <div key={key} className="contents"><DetailTerm>{key}</DetailTerm><DetailValue>{String(value)}</DetailValue></div>)}</dl><RawRecord value={run.runtime} empty={t("runs.noRuntime")} /></div>}
        {tab === "timing" && <TimingDetails run={run} />}
      </div>
      <div className="shrink-0 border-t border-border px-4 py-4">
        <DetailAction icon={<RotateCcw size={14} />} label={t("runs.reproduce")} onClick={onReproduce} />
        <p className="mt-2 text-xs leading-5 text-muted">{t("runs.reproductionHint")}</p>
      </div>
    </div>
  );
}

function InputDetails({ run }: { run: ExecutionRecord }) {
  const { t } = useTranslation();
  const code = run.request.code || run.request.command?.join(" ");
  const input = run.request.input;
  return <DetailSection title={t("runs.tab.input")}>
    {run.request.code_truncated === true && <p className="mb-2 text-sm text-error-text">{t("runs.codeTruncated")}</p>}
    {code ? <pre tabIndex={0} className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-input border border-border bg-surface-2 p-3 font-mono text-[13px] leading-6 text-text">{code}</pre>
      : input && typeof input === "object" ? <JsonBlock value={input as Record<string, unknown>} empty={t("runs.noInput")} />
      : <p className="text-sm text-muted">{run.request.tool || t("runs.noInput")}</p>}
  </DetailSection>;
}

function SummaryDetails({ run, onOpenFile, onOpenArtifact }: { run: ExecutionRecord; onOpenFile: (path: string) => void; onOpenArtifact: (artifact: ExecutionRecord["artifacts"][number]) => void }) {
  const { t } = useTranslation();
  const output = [...new Set([run.result.stdout_preview, run.result.output_preview].filter(Boolean))].join("\n");
  return <div className="space-y-5">
    <InputDetails run={run} />
    {run.files.read.length > 0 && <FileList title={t("runs.filesRead")} icon={<FileSearch size={14} />} files={run.files.read} empty={t("runs.noFilesRead")} onOpen={onOpenFile} compact />}
    <DetailSection title={t("runs.result")}>
      {output ? <><pre tabIndex={0} className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-input border border-border bg-surface-2 p-3 text-[13px] leading-6 text-text">{output}</pre><p className="mt-2 text-xs leading-5 text-muted">{t("runs.logPreview")}</p></>
        : <p className="text-sm text-muted">{executionError(run) || t("runs.noResult")}</p>}
    </DetailSection>
    <FileList title={t("runs.filesWritten")} icon={<FileOutput size={14} />} files={run.files.written} empty={t("runs.noFilesWritten")} onOpen={onOpenFile} compact />
    {run.artifacts.length > 0 && <DetailSection title={t("runs.artifacts")}><div className="flex flex-wrap gap-2">{run.artifacts.map((artifact) => <button type="button" key={`${artifact.artifact_id}:${artifact.version}:${artifact.relation}`} onClick={() => onOpenArtifact(artifact)} title={artifact.artifact_id} className="max-w-full truncate rounded-input border border-border bg-surface px-3 py-2 text-xs text-text">{artifact.artifact_id} · v{artifact.version}<ArrowUpRight size={12} className="ml-2 inline" /></button>)}</div></DetailSection>}
    <details><summary className="cursor-pointer text-sm text-muted">{t("runs.advancedEvidence")}</summary>
      <div className="mt-3 space-y-4">    <dl className="runs-detail-fields grid gap-x-3 gap-y-2 text-sm">
      <DetailTerm>{t("runs.field.status")}</DetailTerm><DetailValue>{t(`runs.status.${run.status}`)}</DetailValue>
      <DetailTerm>{t("runs.field.kind")}</DetailTerm><DetailValue>{t(`runs.kind.${run.kind}`)}</DetailValue>
    </dl>
<dl className="runs-detail-fields grid gap-2 text-xs"><DetailTerm>{t("runs.field.producer")}</DetailTerm><DetailValue>{run.producer}</DetailValue><DetailTerm>{t("runs.field.workspace")}</DetailTerm><DetailValue mono>{run.workspace_id}</DetailValue>{Object.entries(run.runtime).filter(([, value]) => typeof value === "string" || typeof value === "number").map(([key, value]) => <div key={key} className="contents"><DetailTerm>{key}</DetailTerm><DetailValue>{String(value)}</DetailValue></div>)}</dl><TimingDetails run={run} /><RawRecord value={run as unknown as Record<string, unknown>} empty={t("runs.noCorrelation")} /></div>
    </details>
  </div>;
}

function FileDetails({ run, onOpenFile, onOpenArtifact }: { run: ExecutionRecord; onOpenFile: (path: string) => void; onOpenArtifact: (artifact: ExecutionRecord["artifacts"][number]) => void }) {
  const { t } = useTranslation();
  return <div className="space-y-5"><FileList title={t("runs.filesRead")} icon={<FileSearch size={13} />} files={run.files.read} empty={t("runs.noFilesRead")} onOpen={onOpenFile} /><FileList title={t("runs.filesWritten")} icon={<FileOutput size={13} />} files={run.files.written} empty={t("runs.noFilesWritten")} onOpen={onOpenFile} /><DetailSection title={t("runs.artifacts")}>{run.artifacts.length === 0 ? <p className="text-xs text-muted">{t("runs.noArtifacts")}</p> : <div className="space-y-2">{run.artifacts.map((artifact) => <button type="button" onClick={() => onOpenArtifact(artifact)} key={`${artifact.artifact_id}:${artifact.version}:${artifact.relation}`} className="group flex w-full items-center gap-3 rounded-input border border-border bg-surface-2 px-3 py-2 text-left hover:border-accent-border hover:bg-accent-soft"><span className="min-w-0 flex-1"><span className="block truncate font-mono text-[13px] text-text">{artifact.artifact_id}</span><span className="mt-1 block text-xs text-muted">{artifact.relation} · v{artifact.version}</span></span><ArrowUpRight size={13} className="shrink-0 text-muted group-hover:text-accent" /></button>)}</div>}</DetailSection></div>;
}

function FileList({ title, icon, files, empty, onOpen, compact = false }: { title: string; icon: ReactNode; files: ExecutionRecord["files"]["read"]; empty: string; onOpen: (path: string) => void; compact?: boolean }) {
  return <DetailSection title={title} icon={icon}>{files.length === 0 ? <p className="text-xs text-muted">{empty}</p> : <div className="space-y-2">{files.map((file, index) => <button type="button" onClick={() => onOpen(file.path)} key={`${file.path}:${index}`} className="group flex w-full items-center gap-3 rounded-input border border-border bg-surface-2 px-3 py-2 text-left hover:border-accent-border hover:bg-accent-soft"><span className="min-w-0 flex-1"><span className="block break-all font-mono text-[13px] text-text">{file.path}</span>{!compact && <span className="mt-1 block break-all text-xs text-muted">{file.detection}{file.sha256 && ` · SHA-256 ${file.sha256}`}{file.artifact_version && ` · v${file.artifact_version}`}</span>}</span><ArrowUpRight size={13} className="shrink-0 text-muted group-hover:text-accent" /></button>)}</div>}</DetailSection>;
}

function TimingDetails({ run }: { run: ExecutionRecord }) {
  const { t } = useTranslation();
  return <dl className="runs-detail-fields grid gap-x-3 gap-y-3 text-xs"><DetailTerm>{t("runs.field.created")}</DetailTerm><DetailValue mono>{formatTimestamp(run.created_at)}</DetailValue><DetailTerm>{t("runs.field.started")}</DetailTerm><DetailValue mono>{formatTimestamp(run.started_at)}</DetailValue><DetailTerm>{t("runs.field.ended")}</DetailTerm><DetailValue mono>{formatTimestamp(run.ended_at)}</DetailValue><DetailTerm>{t("runs.duration")}</DetailTerm><DetailValue mono>{executionDuration(run, t("runs.running"))}</DetailValue></dl>;
}

function DetailSection({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) { return <section><h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted">{icon}{title}</h3>{children}</section>; }
function DetailAction({ icon, label, onClick, primary = false }: { icon: ReactNode; label: string; onClick: () => void; primary?: boolean }) { return <button type="button" onClick={onClick} className={cn("flex min-h-7 items-center gap-1.5 rounded-input border px-2.5 text-xs transition-colors", primary ? "border-accent-border bg-accent-fill text-accent-fg hover:opacity-90" : "border-border bg-surface text-muted hover:border-border-strong hover:text-text")}>{icon}{label}</button>; }
function DetailTerm({ children }: { children: ReactNode }) { return <dt className="text-muted">{children}</dt>; }
function DetailValue({ children, mono = false }: { children: ReactNode; mono?: boolean }) { return <dd className={cn("min-w-0 break-all text-text", mono && "font-mono text-[13px]")}>{children}</dd>; }
function JsonBlock({ value, empty }: { value: Record<string, unknown>; empty: string }) { return Object.keys(value).length === 0 ? <p className="text-xs text-muted">{empty}</p> : <pre tabIndex={0} className="max-h-[440px] overflow-auto whitespace-pre-wrap break-words rounded-input border border-border bg-surface-2 p-3 font-mono text-[13px] leading-relaxed text-text">{JSON.stringify(value, null, 2)}</pre>; }

function RawRecord({ value, empty }: { value: Record<string, unknown>; empty: string }) {
  const { t } = useTranslation();
  return <details><summary className="cursor-pointer text-xs text-muted">{t("runs.rawRecord")}</summary><div className="mt-2"><JsonBlock value={value} empty={empty} /></div></details>;
}
