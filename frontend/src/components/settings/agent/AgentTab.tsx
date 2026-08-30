import { useTranslation } from "react-i18next";
import { ContextManagementSection } from "../ContextManagementSection";
import type { SettingsConfig } from "../../../lib/settings";

function compactionPointTokens(contextWindow: number, threshold: number, maxOutputTokens: number | null): number {
  const thresholdReserve = Math.round(contextWindow * (1 - threshold / 100));
  const outputReserve = Math.min(32_000, Math.max(8_192, maxOutputTokens ?? 16_384));
  const overhead = Math.min(16_384, Math.max(4_096, Math.round(contextWindow * 0.04)));
  return contextWindow - Math.min(contextWindow - 1_024, Math.max(thresholdReserve, outputReserve + overhead));
}

export function AgentTab({ config, saving, onSave }: { config: SettingsConfig | null; saving: boolean; onSave: (enabled: boolean, threshold: number) => Promise<void> }) {
  const { t } = useTranslation();
  if (!config) return null;
  const selectedModel = config.available_models.find((model) => model.id === config.model);
  const contextWindow = selectedModel?.context_window || config.model_context_window || null;
  const maxOutputTokens = selectedModel?.max_output_tokens || config.model_max_output_tokens || null;
  const contextTokens = contextWindow ? compactionPointTokens(contextWindow, config.compaction_threshold_percent, maxOutputTokens) : null;
  const outputReserve = Math.min(32_000, Math.max(8_192, maxOutputTokens ?? 16_384));
  return (
    <div className="space-y-6">
      <header>
        <p className="max-w-2xl text-ui-caption text-muted">{t("settings.agent.description")}</p>
      </header>
      <section aria-labelledby="agent-context-title" className="border-y border-faint">
        <div className="border-b border-faint py-4">
          <h3 id="agent-context-title" className="text-ui-label font-medium text-text">{t("settings.agent.contextTitle")}</h3>
          <p className="mt-1 text-ui-caption text-muted">{t("settings.agent.contextDescription")}</p>
        </div>
        <ContextManagementSection config={config} saving={saving} onSave={onSave} />
      </section>
      <section aria-labelledby="agent-model-title" className="border-y border-faint py-4">
        <h3 id="agent-model-title" className="text-ui-label font-medium text-text">{t("settings.agent.activeModelTitle")}</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div><p className="text-ui-meta text-muted">{t("settings.agent.activeModel")}</p><p className="mt-1 truncate text-ui-caption text-text">{selectedModel?.model || config.model || t("settings.agent.noModel")}</p></div>
          <div><p className="text-ui-meta text-muted">{t("settings.agent.contextLimit")}</p><p className="mt-1 text-ui-caption text-text">{contextWindow ? `${contextTokens?.toLocaleString()} / ${contextWindow.toLocaleString()} tokens` : t("settings.agent.unknownContext")}</p></div>
          <div><p className="text-ui-meta text-muted">{t("settings.agent.outputReserve")}</p><p className="mt-1 text-ui-caption text-text">{outputReserve.toLocaleString()} tokens</p></div>
        </div>
      </section>
    </div>
  );
}
