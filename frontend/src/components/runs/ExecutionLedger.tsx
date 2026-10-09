import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionRecord } from "@pi-science/contracts";
import { cn } from "../../lib/ui";
import { timeAgo } from "../../lib/shared";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon";
import { executionDuration, executionError, executionLabel, isProblemExecution, outputCount } from "./run-formatters";

export interface ExecutionLedgerProps {
  runs: ExecutionRecord[];
  selectedId: string | null;
  onSelect: (executionId: string) => void;
}

export function ExecutionLedger({ runs, selectedId, onSelect }: ExecutionLedgerProps) {
  const { t } = useTranslation();
  const grouped = useMemo(() => {
    const groups: { label: string; records: ExecutionRecord[] }[] = [];
    for (const run of runs) {
      const date = new Date(run.started_at ?? run.created_at);
      const label = Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      const last = groups[groups.length - 1];
      if (last?.label === label) last.records.push(run);
      else groups.push({ label, records: [run] });
    }
    return groups;
  }, [runs]);
  return (
    <section aria-label={t("runs.ledger")} className="runs-ledger-pane min-w-0">
      <div className="runs-ledger-columns grid items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
        <span>#</span><span>{t("runs.execution")}</span><span>{t("runs.duration")}</span>
      </div>
      <div className="max-h-[620px] overflow-y-auto">
        {grouped.map((group) => <div key={group.label}><div className="sticky top-0 z-10 border-b border-border bg-surface-2 px-3 py-2 text-[11px] font-semibold text-muted">{group.label}</div>{group.records.map((run) => <ExecutionRow key={run.execution_id} run={run} index={runs.indexOf(run) + 1} selected={run.execution_id === selectedId} onClick={() => onSelect(run.execution_id)} />)}</div>)}
      </div>
    </section>
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
