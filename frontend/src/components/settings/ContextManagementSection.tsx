import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsConfig } from "../../lib/settings";

function clampCompactionThreshold(value: number): number { return Math.min(95, Math.max(50, value)); }

export function ContextManagementSection({ config, saving, onSave }: { config: SettingsConfig; saving: boolean; onSave: (enabled: boolean, threshold: number) => Promise<void> }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(config.compaction_enabled !== false);
  const [threshold, setThreshold] = useState(clampCompactionThreshold(config.compaction_threshold_percent || 85));
  const thresholdSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingThreshold = useRef<number | null>(null);

  useEffect(() => {
    setEnabled(config.compaction_enabled !== false);
    setThreshold(clampCompactionThreshold(config.compaction_threshold_percent || 85));
  }, [config.compaction_enabled, config.compaction_threshold_percent]);

  useEffect(() => {
    return () => {
      if (thresholdSaveTimer.current !== null) {
        clearTimeout(thresholdSaveTimer.current);
      }
    };
  }, []);

  const clearThresholdTimer = () => {
    if (thresholdSaveTimer.current !== null) {
      clearTimeout(thresholdSaveTimer.current);
      thresholdSaveTimer.current = null;
    }
  };

  const flushThresholdSave = () => {
    const nextThreshold = pendingThreshold.current;
    if (nextThreshold === null) return;
    clearThresholdTimer();
    pendingThreshold.current = null;
    void onSave(enabled, nextThreshold);
  };

  const updateEnabled = (nextEnabled: boolean) => {
    const nextThreshold = pendingThreshold.current ?? threshold;
    clearThresholdTimer();
    pendingThreshold.current = null;
    setEnabled(nextEnabled);
    void onSave(nextEnabled, nextThreshold);
  };

  const updateThreshold = (nextThreshold: number) => {
    setThreshold(nextThreshold);
    pendingThreshold.current = nextThreshold;
    clearThresholdTimer();
    thresholdSaveTimer.current = setTimeout(() => {
      thresholdSaveTimer.current = null;
      flushThresholdSave();
    }, 250);
  };

  const selectedModel = config.available_models.find((model) => model.id === config.model);
  const contextWindow = selectedModel?.context_window || config.model_context_window || null;
  const thresholdTokens = contextWindow ? Math.round(contextWindow * threshold / 100) : null;

  return (
    <section className="overflow-hidden rounded-card border border-faint bg-surface-2/40">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-faint px-4 py-2">
        <h2 className="text-[13px] font-semibold text-text">{t("settings.context.title")}</h2>
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-text">
          <span>{t("settings.context.autoCompact")}</span>
          <span className="relative inline-flex h-5 w-9 shrink-0 rounded-full bg-surface-2 transition-colors has-[:checked]:bg-accent-fill">
            <input type="checkbox" checked={enabled} disabled={saving} onChange={(event) => updateEnabled(event.target.checked)} className="peer sr-only" />
            <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-accent-fg shadow-sm transition-transform peer-checked:translate-x-4" />
          </span>
        </label>
      </div>
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="compaction-threshold" className="text-[12px] font-medium text-text">{t("settings.context.threshold")}</label>
          <output className="font-mono text-[11px] text-text">{threshold}%</output>
        </div>
        <input id="compaction-threshold" type="range" min={50} max={95} step={1} value={threshold} disabled={!enabled || saving} onChange={(event) => updateThreshold(Number(event.target.value))} onPointerUp={flushThresholdSave} onKeyUp={flushThresholdSave} onBlur={flushThresholdSave} className="mt-2 h-8 w-full cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50" />
        <p className="mt-1 text-[10px] leading-relaxed text-muted">
          {t("settings.context.thresholdHelp", { threshold, tokens: thresholdTokens ? thresholdTokens.toLocaleString() : "—", window: contextWindow ? contextWindow.toLocaleString() : "—" })}
        </p>
      </div>
    </section>
  );
}
