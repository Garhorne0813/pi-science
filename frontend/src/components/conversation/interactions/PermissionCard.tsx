import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PendingInteraction } from "../../../lib/agent-runtime";

interface PermissionCardProps {
  interaction: PendingInteraction;
  submitting: boolean;
  selectedOption: string | null;
  selectedConfirmation: boolean | null;
  selectedAlwaysAllow: boolean;
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean; alwaysAllow?: boolean }) => void;
}

export function PermissionCard({ interaction, submitting, selectedOption, selectedConfirmation, selectedAlwaysAllow, onRespond }: PermissionCardProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus();
  }, [interaction.requestId]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Enter on the focused dialog approves only once. Native button keyboard
    // activation owns Enter after focus moves to a button.
    if (interaction.method !== "confirm" || event.key !== "Enter" || event.repeat
      || event.nativeEvent.isComposing || submitting || event.target !== event.currentTarget) return;
    event.preventDefault();
    onRespond({ confirmed: true });
  };
  const options = (interaction.options || []).map((option) => typeof option === "string"
    ? { label: option, value: option }
    : { label: option.label || option.value || t("interaction.option"), value: option.value || option.label || "" });
  return <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="rounded-card border border-accent/30 bg-accent/5 p-4 animate-fadeIn outline-none" role="alertdialog" aria-labelledby={`permission-${interaction.requestId}`}>
    <div className="flex items-start gap-3">
      <span className="mt-0.5 rounded-full bg-accent/10 p-1.5 text-accent"><ShieldCheck size={16} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <div id={`permission-${interaction.requestId}`} className="text-xs font-semibold uppercase tracking-wide text-accent">{t("interaction.approvalRequired")}</div>
        <div className="mt-1 text-sm font-medium text-text">{interaction.operation || interaction.title}</div>
        {interaction.message && <div className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{interaction.message}</div>}
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
      <button type="button" disabled={submitting} onClick={() => onRespond({ confirmed: true })} className="inline-flex items-center gap-1.5 rounded-input bg-accent-fill px-3 py-1.5 text-xs text-accent-fg disabled:opacity-50">{submitting && selectedConfirmation === true && !selectedAlwaysAllow && <Loader2 size={12} className="animate-spin" />}{t("interaction.allowOnce")}</button>
      {interaction.mcpGrant && <button type="button" title={t("interaction.allowAlwaysScope")} disabled={submitting} onClick={() => onRespond({ confirmed: true, alwaysAllow: true })} className="inline-flex items-center gap-1.5 rounded-input border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/15 disabled:opacity-50">{submitting && selectedAlwaysAllow && <Loader2 size={12} className="animate-spin" />}{t("interaction.allowAlways")}</button>}
    </div>}
  </div>;
}
