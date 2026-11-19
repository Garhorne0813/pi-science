import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
  const [scope, setScope] = useState<"once" | "conversation" | "project" | "global">(interaction.mcpGrant ? "project" : "conversation");
  const [confirmBroadScope, setConfirmBroadScope] = useState(false);
  useEffect(() => {
    rootRef.current?.focus();
    setScope(interaction.mcpGrant ? "project" : "conversation");
    setConfirmBroadScope(false);
  }, [interaction.requestId]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Enter on the focused dialog approves only once. Native button keyboard
    // activation owns Enter after focus moves to a button.
    if (interaction.method !== "confirm" || event.key !== "Enter" || event.repeat
      || event.nativeEvent.isComposing || submitting || event.target !== event.currentTarget) return;
    event.preventDefault();
    onRespond({ confirmed: true });
  };
  const presentation = interaction.presentation;
  const title = presentation
    ? t(presentation.titleKey, { ...(presentation.titleParams ?? {}), defaultValue: interaction.operation || interaction.title })
    : interaction.operation || interaction.title;
  const message = presentation?.messageKey
    ? t(presentation.messageKey, { ...(presentation.messageParams ?? {}), defaultValue: interaction.message })
    : interaction.message;
  const options = (interaction.options || []).map((option) => {
    const value = typeof option === "string" ? option : option.value || option.label || "";
    const fallback = typeof option === "string" ? option : option.label || option.value || t("interaction.option");
    const labelKey = presentation?.optionLabelKeys?.[value];
    return { label: labelKey ? t(labelKey, { defaultValue: fallback }) : fallback, value };
  });
  const localExecution = presentation?.titleKey === "interaction.localExecution.title";
  const scoped = localExecution || !!interaction.mcpGrant;
  const approve = () => {
    if (localExecution && (scope === "project" || scope === "global") && !confirmBroadScope) {
      setConfirmBroadScope(true);
      return;
    }
    if (localExecution) onRespond({ value: scope });
    else if (scope === "once") onRespond({ confirmed: true });
    else if (scope === "conversation" || scope === "global") onRespond({ value: scope });
    else onRespond({ confirmed: true, alwaysAllow: true });
  };
  const detail = scoped || presentation?.titleKey === "interaction.networkApproval.title";
  const networkReason = presentation?.titleKey === "interaction.networkApproval.title" && message?.includes("\n\n")
    ? message.split("\n\n", 1)[0]
    : null;
  return <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="rounded-card border border-accent/30 bg-accent/5 p-4 animate-fadeIn outline-none" role="alertdialog" aria-labelledby={`permission-${interaction.requestId}`}>
    <div className="flex items-start gap-3">
      <span className="mt-0.5 rounded-full bg-accent/10 p-1.5 text-accent"><ShieldCheck size={16} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <div id={`permission-${interaction.requestId}`} className="text-xs font-semibold uppercase tracking-wide text-accent">{t("interaction.approvalRequired")}</div>
        <div className="mt-1 text-sm font-medium text-text">{title}</div>
        {networkReason && <p className="mt-2 text-sm leading-relaxed text-text">{networkReason}</p>}
        {message && (detail ? <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">{t("interaction.details")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-input bg-surface px-3 py-2 font-mono text-xs">{networkReason ? message.slice(networkReason.length + 2) : message}</pre></details> : <div className="mt-1 text-sm leading-relaxed text-muted">{message}</div>)}
        {(interaction.scope || interaction.effect) && <dl className="mt-3 grid gap-1.5 text-xs sm:grid-cols-[auto_1fr]">
          {interaction.scope && <><dt className="font-medium text-muted">{t("interaction.scope")}</dt><dd className="text-text">{interaction.scope}</dd></>}
          {interaction.effect && <><dt className="font-medium text-muted">{t("interaction.effect")}</dt><dd className="text-text">{interaction.effect}</dd></>}
        </dl>}
      </div>
    </div>
    {scoped ? <div className="mt-4 flex flex-wrap items-end justify-end gap-2">
      <label className="mr-auto text-xs text-muted">{t("interaction.allowScope")}<select aria-label={t("interaction.allowScope")} value={scope} disabled={submitting} onChange={(event) => { setScope(event.target.value as typeof scope); setConfirmBroadScope(false); }} className="mt-1 block h-9 rounded-input border border-border bg-surface px-2 text-xs text-text">
        <option value="once">{t("interaction.allowOnce")}</option>
        <option value="conversation">{t("interaction.allowConversation")}</option>
        <option value="project">{t("interaction.allowProject")}</option>
        <option value="global">{t("interaction.allowGlobal")}</option>
      </select></label>
      {confirmBroadScope && <p className="w-full text-xs text-muted">{t("interaction.broadExecutionConfirm", { scope: t(`interaction.scope.${scope}`) })}</p>}
      <button type="button" disabled={submitting} onClick={() => onRespond({ confirmed: false })} className="rounded-input border border-border px-3 py-1.5 text-xs text-text">{t("interaction.deny")}</button>
      <button type="button" disabled={submitting} onClick={approve} className="rounded-input bg-accent-fill px-3 py-1.5 text-xs text-accent-fg">{submitting && <Loader2 size={12} className="mr-1 inline animate-spin" />}{confirmBroadScope ? t("interaction.confirmScope") : t("interaction.allow")}</button>
    </div> : interaction.method === "select" && options.length > 0 ? <div className="mt-4 flex flex-wrap justify-end gap-2">
      {options.map((option) => <button type="button" key={`${option.label}-${option.value}`} disabled={submitting} onClick={() => onRespond({ value: option.value })} className={`inline-flex items-center gap-1.5 rounded-input px-3 py-1.5 text-xs disabled:opacity-50 ${option.value === "allow" ? "bg-accent-fill text-accent-fg" : "border border-border bg-surface text-text hover:border-accent"}`}>
        {submitting && selectedOption === option.value && <Loader2 size={12} className="animate-spin" />}{option.label}
      </button>)}
    </div> : <div className="mt-4 flex justify-end gap-2">
      <button type="button" disabled={submitting} onClick={() => onRespond({ confirmed: false })} className="inline-flex items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-2 disabled:opacity-50">{submitting && selectedConfirmation === false && <Loader2 size={12} className="animate-spin" />}{t("interaction.deny")}</button>
      <button type="button" disabled={submitting} onClick={() => onRespond({ confirmed: true })} className="inline-flex items-center gap-1.5 rounded-input bg-accent-fill px-3 py-1.5 text-xs text-accent-fg disabled:opacity-50">{submitting && selectedConfirmation === true && !selectedAlwaysAllow && <Loader2 size={12} className="animate-spin" />}{t("interaction.allowOnce")}</button>
    </div>}
  </div>;
}
