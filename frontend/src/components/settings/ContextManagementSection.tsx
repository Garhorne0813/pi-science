import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SettingsConfig } from "../../lib/settings";
import { contextPolicy } from "./agent/context-policy";

export function ContextManagementSection({ config, saving, onSave }: { config: SettingsConfig; saving: boolean; onSave: (enabled: boolean, threshold: number) => Promise<void> }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(config.compaction_enabled !== false);
  const [threshold, setThreshold] = useState(config.compaction_threshold_percent ?? 85);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setEnabled(config.compaction_enabled !== false);
    setThreshold(config.compaction_threshold_percent ?? 85);
  }, [config.compaction_enabled, config.compaction_threshold_percent]);
  const dirty = enabled !== (config.compaction_enabled !== false) || threshold !== (config.compaction_threshold_percent ?? 85);
  const policy = contextPolicy(config, threshold);
  const submit = async () => {
    setSaved(false);
    try { await onSave(enabled, threshold); setSaved(true); }
    catch { /* The settings shell displays the server error; retain the draft. */ }
  };
  return (
    <section aria-labelledby="context-management-title" className="rounded-card border border-border bg-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 id="context-management-title" className="text-ui-body font-medium text-text">{t("settings.context.title")}</h2>
          <p className="mt-1 text-ui-caption leading-relaxed text-muted">{t("settings.context.description")}</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-ui-caption text-text">
          <span>{t("settings.context.autoCompact")}</span>
          <span className="relative inline-flex h-5 w-9 shrink-0 rounded-full bg-surface-2 transition-colors has-[:checked]:bg-accent-fill">
            <input type="checkbox" checked={enabled} disabled={saving} onChange={(event) => { setEnabled(event.target.checked); setSaved(false); }} className="peer sr-only" />
            <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-accent-fg transition-transform peer-checked:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-accent" />
          </span>
        </label>
      </div>
      <div className="mt-4 border-t border-faint pt-4">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="compaction-threshold" className="text-ui-label text-text">{t("settings.context.threshold")}</label>
          <output htmlFor="compaction-threshold" className="rounded-input bg-surface-2 px-2 py-1 font-mono text-ui-caption text-text">{threshold}%</output>
        </div>
        <input id="compaction-threshold" type="range" min={50} max={95} step={1} value={threshold} disabled={!enabled || saving} onChange={(event) => { setThreshold(Number(event.target.value)); setSaved(false); }} aria-describedby="compaction-preview" className="mt-2 h-8 w-full cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50" />
        <div id="compaction-preview" className="mt-2 rounded-card bg-sidebar p-4">
          <p className="text-ui-caption text-muted">{t(enabled ? "settings.redesign.contextPreview" : "settings.redesign.compactionOff")}</p>
          {policy ? <>
            <div aria-hidden="true" className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-selected"><span className={enabled ? "bg-accent" : "bg-muted"} style={{ width: `${threshold}%` }} /></div>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><dt className="text-ui-caption text-muted">{t("settings.redesign.compactionPoint")}</dt><dd className="mt-1 font-mono text-ui-body text-text">{enabled ? t("settings.redesign.tokens", { count: policy.compactionPointTokens }) : "—"}</dd></div>
              <div><dt className="text-ui-caption text-muted">{t("settings.redesign.reservedContext")}</dt><dd className="mt-1 font-mono text-ui-body text-text">{enabled ? t("settings.redesign.tokens", { count: policy.compaction.reserveTokens }) : "—"}</dd></div>
            </dl>
          </> : <p className="mt-2 text-ui-caption text-muted">{t("settings.agent.unknownContext")}</p>}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="flex items-center gap-1 text-ui-caption text-muted">{saved ? <><Check size={14} />{t("settings.redesign.saved")}</> : dirty ? t("settings.redesign.unsaved") : t("settings.redesign.contextHelp")}</p>
          <button type="button" aria-label={t("settings.redesign.saveContext")} disabled={saving || !dirty} onClick={() => void submit()} className="flex min-h-9 items-center gap-2 rounded-input bg-accent-fill px-3 text-ui-label font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-40">{saving && <Loader2 size={14} className="animate-spin" />}{t("common.save")}</button>
        </div>
      </div>
    </section>
  );
}
