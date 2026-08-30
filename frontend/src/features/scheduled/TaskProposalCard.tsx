import { useState, type ReactNode } from "react";
import { Bell, CalendarClock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { LITERATURE_PROVIDERS, type DeliveryPolicy } from "../../lib/scheduled-tasks";
import { deliveryLabel, humanSchedule, type ScheduledTaskProposal } from "./model";

export function TaskProposalCard({ proposal, saving, onChange, onCancel, onConfirm, compact = false }: { proposal: ScheduledTaskProposal; saving: boolean; onChange: (proposal: ScheduledTaskProposal) => void; onCancel?: () => void; onConfirm: (runNow: boolean) => void; compact?: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const updateClock = (clock: string) => {
    const [hour, minute] = clock.split(":").map(Number);
    const schedule = proposal.schedule.canonical;
    if (schedule.type !== "cron" || !Number.isFinite(hour) || !Number.isFinite(minute)) return;
    const fields = schedule.expression.split(/\s+/);
    fields[0] = String(minute);
    fields[1] = String(hour);
    const canonical = { ...schedule, expression: fields.join(" ") };
    onChange({ ...proposal, schedule: { canonical, display_text: humanSchedule(canonical) } });
  };
  const cron = proposal.schedule.canonical.type === "cron" ? proposal.schedule.canonical.expression.split(/\s+/) : null;
  const clock = cron ? `${cron[1]!.padStart(2, "0")}:${cron[0]!.padStart(2, "0")}` : "09:00";
  return (
    <section aria-label={t("st.proposalTitle")} className={cn("rounded-card border border-accent-border bg-surface p-4", !compact && "mt-4")}>
      <div className="flex items-center gap-2 text-xs font-medium text-accent"><CalendarClock size={14} />{t("st.proposalTitle")}</div>
      {editing ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label={t("st.field.name")}><input aria-label={t("st.field.name")} value={proposal.title} onChange={(event) => onChange({ ...proposal, title: event.target.value })} className={inputClass} /></Field>
          {proposal.schedule.canonical.type === "cron" && <Field label={t("st.field.time")}><input aria-label={t("st.field.time")} type="time" value={clock} onChange={(event) => updateClock(event.target.value)} className={inputClass} /></Field>}
          <Field label={t("st.field.query")}><input aria-label={t("st.field.query")} value={proposal.query} onChange={(event) => onChange({ ...proposal, query: event.target.value, action_summary: `Track ${event.target.value} across ${proposal.providers.join(" + ")}` })} className={inputClass} /></Field>
          <Field label={t("st.notifyWhen")}><select aria-label={t("st.notifyWhen")} value={proposal.delivery_policy} onChange={(event) => onChange({ ...proposal, delivery_policy: event.target.value as DeliveryPolicy })} className={inputClass}><option value="always">{deliveryLabel("always")}</option><option value="only_when_relevant">{deliveryLabel("only_when_relevant")}</option><option value="only_on_change">{deliveryLabel("only_on_change")}</option><option value="only_on_failure">{deliveryLabel("only_on_failure")}</option></select></Field>
          <Field label={t("st.field.providers")}><div className="flex flex-wrap gap-1.5">{LITERATURE_PROVIDERS.map((provider) => { const active = proposal.providers.includes(provider); return <button key={provider} type="button" aria-pressed={active} onClick={() => onChange({ ...proposal, providers: active ? proposal.providers.filter((item) => item !== provider) : [...proposal.providers, provider] })} className={cn("rounded-input border px-2 py-1 text-ui-meta", active ? "border-accent-border bg-accent-soft text-accent" : "border-border text-muted")}>{provider}</button>; })}</div></Field>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><h2 className="text-base font-medium text-text">{proposal.title}</h2><p className="mt-1 text-xs leading-5 text-muted">{proposal.action_summary}</p></div>
          <dl className="space-y-2 text-xs"><div><dt className="text-muted">{t("st.scheduleLabel")}</dt><dd className="mt-0.5 text-text">{proposal.schedule.display_text}</dd></div><div><dt className="text-muted">{t("st.notifyWhen")}</dt><dd className="mt-0.5 flex items-center gap-1 text-text"><Bell size={12} />{deliveryLabel(proposal.delivery_policy)}</dd></div></dl>
        </div>
      )}
      <p className="mt-3 text-ui-meta text-muted">{t("st.resultsSaved")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={saving || !proposal.title.trim() || !proposal.query.trim() || proposal.providers.length === 0} onClick={() => onConfirm(true)} className="min-h-8 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg disabled:opacity-50">{saving ? t("st.saving") : t("st.scheduleAndRun")}</button>
        <button type="button" disabled={saving} onClick={() => onConfirm(false)} className="min-h-8 rounded-input border border-border px-3 text-xs text-text disabled:opacity-50">{t("st.scheduleOnly")}</button>
        <button type="button" onClick={() => setEditing((value) => !value)} className="min-h-8 rounded-input border border-border px-3 text-xs text-muted">{editing ? t("common.done") : t("common.edit")}</button>
        {onCancel && <button type="button" onClick={onCancel} className="min-h-8 px-2 text-xs text-muted">{t("common.cancel")}</button>}
      </div>
    </section>
  );
}

const inputClass = "min-h-9 w-full rounded-input border border-border bg-surface px-3 text-xs text-text outline-none transition-colors placeholder:text-muted focus:border-accent";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1 block text-ui-meta font-medium text-muted">{label}</span>{children}</label>;
}
