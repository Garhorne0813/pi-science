import { useEffect, useRef } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PendingInteraction } from "../../../lib/agent-runtime";

interface PermissionCardProps {
  interaction: PendingInteraction;
  submitting: boolean;
  selectedOption: string | null;
  selectedConfirmation: boolean | null;
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}

export function PermissionCard({ interaction, submitting, selectedOption, selectedConfirmation, onRespond }: PermissionCardProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus();
  }, [interaction.requestId]);
  const options = (interaction.options || []).map((option) => typeof option === "string"
    ? { label: option, value: option }
    : { label: option.label || option.value || t("interaction.option"), value: option.value || option.label || "" });
  return <div ref={rootRef} tabIndex={-1} className="rounded-card border border-accent/30 bg-accent/5 p-4 animate-fadeIn outline-none" role="alertdialog" aria-labelledby={`permission-${interaction.requestId}`}>
    <div className="flex items-start gap-3">
      <span className="mt-0.5 rounded-full bg-accent/10 p-1.5 text-accent"><ShieldCheck size={16} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <div id={`permission-${interaction.requestId}`} className="text-xs font-semibold uppercase tracking-wide text-accent">{t("interaction.approvalRequired")}</div>
        <div className="mt-1 text-sm font-medium text-text">{interaction.operation || interaction.title}</div>
        {interaction.message && <div className="mt-1 text-sm leading-relaxed text-muted">{interaction.message}</div>}
        {(interaction.scope || interaction.effect) && <dl className="mt-3 grid gap-1.5 text-xs sm:grid-cols-[auto_1fr]">
          {interaction.scope && <><dt className="font-medium text-muted">{t("interaction.scope")}</dt><dd className="text-text">{interaction.scope}</dd></>}
          {interaction.effect && <><dt className="font-medium text-muted">{t("interaction.effect")}</dt><dd className="text-text">{interaction.effect}</dd></>}
        </dl>}
      </div>
    </div>
    {interaction.method === "select" && options.length > 0 ? <div className="mt-4 flex flex-wrap justify-end gap-2">
      {options.map((option) => <button type="button" key={`${option.label}-${option.value}`} disabled={submitting} onClick={() => onRespond({ value: option.value })} className="inline-flex items-center gap-1.5 rounded-input border border-border bg-surface px-3 py-1.5 text-xs text-text hover:border-accent disabled:opacity-50">
        {submitting && selectedOption === option.value && <Loader2 size={12} className="animate-spin" />}{option.label}
      </button>)}
    </div> : <div className="mt-4 flex justify-end gap-2">
      <button type="button" disabled={submitting} onClick={() => onRespond({ confirmed: false })} className="inline-flex items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-2 disabled:opacity-50">{submitting && selectedConfirmation === false && <Loader2 size={12} className="animate-spin" />}{t("interaction.deny")}</button>
      <button type="button" disabled={submitting} onClick={() => onRespond({ confirmed: true })} className="inline-flex items-center gap-1.5 rounded-input bg-accent-fill px-3 py-1.5 text-xs text-accent-fg disabled:opacity-50">{submitting && selectedConfirmation === true && <Loader2 size={12} className="animate-spin" />}{t("interaction.allowOnce")}</button>
    </div>}
  </div>;
}
