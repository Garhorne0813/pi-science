import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsConfig } from "../../lib/settings-types";

function clampCompactionThreshold(value: number): number { return Math.min(95, Math.max(50, value)); }

export function ContextManagementSection({ config, saving, onSave }: { config: SettingsConfig; saving: boolean; onSave: (enabled: boolean, threshold: number) => Promise<void> }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(config.compaction_enabled !== false);
  const [threshold, setThreshold] = useState(clampCompactionThreshold(config.compaction_threshold_percent || 85));

  useEffect(() => {
    setEnabled(config.compaction_enabled !== false);
    setThreshold(clampCompactionThreshold(config.compaction_threshold_percent || 85));
  }, [config.compaction_enabled, config.compaction_threshold_percent]);

  const selectedModel = config.available_models.find((model) => model.id === config.model);
  const contextWindow = selectedModel?.context_window || null;
  const thresholdTokens = contextWindow ? Math.round(contextWindow * threshold / 100) : null;

  return (
    <section className="overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-faint px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-text">{t("settings.context.title")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t("settings.context.description")}</p>
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-text">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
          {t("settings.context.autoCompact")}
        </label>
      </div>
      <div className="px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="compaction-threshold" className="text-xs font-medium text-text">{t("settings.context.threshold")}</label>
          <output className="font-mono text-xs text-text">{threshold}%</output>
        </div>
        <input id="compaction-threshold" type="range" min={50} max={95} step={1} value={threshold} disabled={!enabled || saving} onChange={(event) => setThreshold(Number(event.target.value))} className="mt-3 h-11 w-full cursor-pointer accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50" />
        <p className="text-[11px] leading-relaxed text-muted">
          {t("settings.context.thresholdHelp", { threshold, tokens: thresholdTokens ? thresholdTokens.toLocaleString() : "—", window: contextWindow ? contextWindow.toLocaleString() : "—" })}
        </p>
        <div className="mt-4 flex justify-end">
          <button type="button" disabled={saving} onClick={() => void onSave(enabled, threshold)} className="min-h-11 rounded-input bg-accent px-4 text-xs font-medium text-accent-fg disabled:cursor-wait disabled:opacity-50">
            {saving ? t("settings.context.saving") : t("settings.context.save")}
          </button>
        </div>
      </div>
    </section>
  );
}
