import { useTranslation } from "react-i18next";
import type { ExecutionRecord } from "@pi-science/contracts";
import { cn } from "../../lib/ui";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon";
import { executionDuration, formatTimestamp, executionLabel, executionPreview, executionShortLabel, executionError, isProblemExecution, outputCount } from "./run-formatters";

export interface ExecutionLedgerProps {
  runs: ExecutionRecord[];
  selectedId: string | null;
  onSelect: (executionId: string) => void;
  groupBySession?: boolean;
  sessionTitles?: Record<string, string>;
  showSession?: boolean;
}

export function ExecutionLedger({ runs, selectedId, onSelect, groupBySession, sessionTitles = {}, showSession = true }: ExecutionLedgerProps) {
  const { t } = useTranslation();
  const groups = groupBySession ? [...new Set(runs.map((run) => run.correlation.session_id ?? ""))].map((id) => ({
    id, runs: runs.filter((run) => (run.correlation.session_id ?? "") === id),
  })) : [{ id: "", runs }];
  return (
    <section aria-label={t("runs.ledger")} className="runs-ledger-pane min-w-0">
      <div className="runs-ledger-columns grid items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
        <span>#</span><span>{t("runs.execution")}</span><span>{t("runs.duration")}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((group) => <div key={group.id}>
          {groupBySession && <h3 className="break-all bg-surface-2 px-3 py-2 text-xs text-muted">{sessionTitles[group.id] || group.id || t("runs.unassociated")}</h3>}
          {group.runs.map((run, index) => <ExecutionRow key={run.execution_id} run={run} showSession={showSession && !groupBySession} sessionTitle={sessionTitles[run.correlation.session_id || ""]} index={index + 1} selected={run.execution_id === selectedId} onClick={() => onSelect(run.execution_id)} />)}
        </div>)}
      </div>
    </section>
  );
}

function ExecutionRow({ run, index, selected, onClick, showSession, sessionTitle }: { run: ExecutionRecord; showSession: boolean; sessionTitle?: string; index: number; selected: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const outputs = outputCount(run);
  const label = executionShortLabel(run);
  const source = executionPreview(executionLabel(run));
  const summary = isProblemExecution(run) ? executionError(run) || run.result.output_preview || run.result.stdout_preview : run.result.output_preview || run.result.stdout_preview || run.result.stderr_preview;
  return (
    <button type="button" onClick={onClick} aria-current={selected ? "true" : undefined} className={cn("runs-ledger-columns runs-ledger-row grid w-full items-start gap-2 border-b border-faint px-3 py-3 text-left transition-colors last:border-b-0", selected && "runs-ledger-row-selected")}>
      <span className="pt-0.5 text-xs tabular-nums text-muted">{index}</span>
      <span className="min-w-0">
        <span className="flex items-center gap-2"><ExecutionStatusIcon status={run.status} /><span title={source} className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{label}</span>{label !== source && <span className="sr-only">{source}</span>}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-xs text-muted">
          <span className="font-semibold uppercase tracking-wide text-text">{run.surface}</span><span>{t(`runs.kind.${run.kind}`)}</span><span>{formatTimestamp(run.started_at ?? run.created_at)}</span><span>{t(`runs.status.${run.status}`)}</span>
          {outputs > 0 && <span>{t("runs.outputCount", { count: outputs })}</span>}
        </span>
        {showSession && <span title={run.correlation.session_id} className="mt-1 block truncate pl-5 text-xs text-muted">{sessionTitle || run.correlation.session_id || t("runs.unassociated")}</span>}
        {summary && <span className={cn("mt-1 line-clamp-2 whitespace-pre-wrap break-all pl-5 text-xs", isProblemExecution(run) ? "text-error-text" : "text-muted")}>{executionPreview(summary, 240)}</span>}
      </span>
      <span className="whitespace-nowrap pt-0.5 font-mono text-xs tabular-nums text-muted">{executionDuration(run, t("runs.running"))}</span>
    </button>
  );
}
