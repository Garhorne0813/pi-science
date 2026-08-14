/**
 * Lightweight Plan Card (reverse-cs-inspiration 5.2): a compact plan
 * confirmation surface for ordinary multi-step tasks — plan version,
 * step list with status, and approve / request-changes actions. Kept
 * independent of the Research Loop so any long task can show a plan
 * gate without entering the loop machinery.
 */

import { Check, RotateCcw, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";

export type PlanStepStatus = "pending" | "current" | "done" | "blocked";

export interface PlanStep {
  label: string;
  status?: PlanStepStatus;
  /** Workspace-relative artifact refs produced by this step. */
  artifactRefs?: string[];
}

export interface PlanCardProps {
  title: string;
  /** Optional plan revision label, e.g. "v2". */
  version?: string;
  steps: PlanStep[];
  onApprove: () => void;
  onRequestChanges?: () => void;
  approveLabel?: string;
  requestChangesLabel?: string;
  approving?: boolean;
  /** Optional note shown under the actions (e.g. what changes were asked). */
  note?: string;
}

export function PlanCard({ title, version, steps, onApprove, onRequestChanges, approveLabel, requestChangesLabel, approving, note }: PlanCardProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-border bg-surface-1/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold">{title}</span>
        {version && <span className="rounded bg-surface-2 px-1.5 py-px font-mono text-[10px] text-muted">{t("planCard.version", { version })}</span>}
      </div>
      <ol className="space-y-1.5">
        {steps.map((step, index) => (
          <li key={index} className="flex items-start gap-2 text-xs leading-5">
            <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px]", stepStatusTone(step.status ?? "pending"))}>
              {step.status === "done" ? <Check size={9} /> : step.status === "current" ? "›" : index + 1}
            </span>
            <span className={cn("min-w-0", step.status === "blocked" && "text-warn")}>
              <span className={cn("block", step.status === "done" && "text-muted line-through opacity-60")}>{step.label}</span>
              {step.artifactRefs && step.artifactRefs.length > 0 && (
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {step.artifactRefs.map((ref) => (
                    <span key={ref} className="rounded bg-surface-2 px-1.5 py-px font-mono text-[9px] text-accent">{ref}</span>
                  ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={approving}
          className="inline-flex items-center gap-1 rounded-md bg-ok/15 px-2.5 py-1 text-xs text-ok hover:bg-ok/25 disabled:opacity-50"
        >
          {approving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          {approveLabel ?? t("planCard.approve")}
        </button>
        {onRequestChanges && (
          <button type="button" onClick={onRequestChanges} disabled={approving} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2.5 py-1 text-xs text-muted hover:bg-surface-2/70 disabled:opacity-50">
            <RotateCcw size={11} />
            {requestChangesLabel ?? t("planCard.requestChanges")}
          </button>
        )}
      </div>
      {note && <div className="mt-2 text-[11px] text-muted">{note}</div>}
    </div>
  );
}

function stepStatusTone(status: PlanStepStatus): string {
  switch (status) {
    case "done": return "bg-ok/15 text-ok";
    case "current": return "bg-accent/15 text-accent";
    case "blocked": return "bg-warn/15 text-warn";
    default: return "bg-surface-2 text-muted";
  }
}
