import { useTranslation } from "react-i18next";
import type { ResearchLoopDetail } from "../../lib/knowledge";

export function ResearchDecisionPanel({ detail }: { detail: ResearchLoopDetail }) {
  const { t } = useTranslation();
  const decision = detail.decision;
  const isolation = detail.execution_isolation;
  return <section className="mt-5 rounded-card border border-border bg-surface p-4" aria-label={t("research.decisionTitle")}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-text">{t("research.decisionTitle")}</h2>
      <span className={isolation?.available ? "text-xs text-ok" : "text-xs text-error-text"}>
        {isolation?.available ? t("research.isolationActive", { backend: isolation.backend }) : t("research.isolationUnavailable")}
      </span>
    </div>
    {!isolation?.available && isolation?.reason && <p className="mt-1 text-xs text-error-text">{isolation.reason}</p>}
    {decision && <>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <DecisionValue label={t("research.incumbent")} value={decision.best_candidate_id ? detail.candidates.find((candidate) => candidate.candidate_id === decision.best_candidate_id)?.proposal.approach_summary ?? decision.best_candidate_id : t("research.noIncumbent")} />
        <DecisionValue label={t("research.frontierCount")} value={String(decision.frontier_candidate_ids.length)} />
        <DecisionValue label={t("research.stagnantRounds")} value={String(decision.stagnant_rounds)} />
      </div>
      {Object.keys(decision.best_metrics).length > 0 && <div className="mt-3 flex flex-wrap gap-2">{Object.entries(decision.best_metrics).map(([name, value]) => <span key={name} className="rounded-full bg-accent/10 px-2.5 py-1 font-mono text-xs text-accent">{name}: {value}{detail.baseline?.[name] != null ? ` · ${t("research.baseline")} ${detail.baseline[name]}` : ""}</span>)}</div>}
      {decision.next_strategy && <div className="mt-3 rounded-input bg-surface-2 px-3 py-2"><div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t("research.nextStrategy")}</div><p className="mt-1 text-xs leading-5 text-text">{decision.next_strategy}</p></div>}
      {decision.last_diagnosis.length > 0 && <p className="mt-2 text-xs leading-5 text-muted">{t("research.lastDiagnosis")}: {decision.last_diagnosis.join(" · ")}</p>}
      {decision.recent_failures.length > 0 && <div className="mt-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t("research.recentFailures")}</div><ul className="mt-1 space-y-1">{decision.recent_failures.map((failure) => <li key={failure.candidate_id} className="truncate text-xs text-error-text" title={failure.reason}>{failure.candidate_id}: {failure.reason}</li>)}</ul></div>}
    </>}
  </section>;
}

function DecisionValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-input bg-surface-2 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted">{label}</div><div className="mt-1 truncate text-xs font-medium text-text" title={value}>{value}</div></div>;
}
