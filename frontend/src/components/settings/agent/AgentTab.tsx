import { ArrowRight, BrainCircuit, Image, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextManagementSection } from "../ContextManagementSection";
import type { SettingsConfig } from "../../../lib/settings";
import { configuredContextWindow } from "./context-policy";

export function AgentTab({ config, saving, onSave, onOpenModels }: { config: SettingsConfig | null; saving: boolean; onSave: (enabled: boolean, threshold: number) => Promise<void>; onOpenModels?: () => void }) {
  const { t } = useTranslation();
  if (!config) return null;
  const selectedModel = config.available_models.find((model) => model.id === config.model);
  const contextWindow = configuredContextWindow(config);
  return (
    <div className="space-y-6">
      <p className="text-ui-caption leading-relaxed text-muted">{t("settings.agent.description")}</p>
      <section aria-labelledby="agent-model-title" className="rounded-card border border-border bg-sidebar p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="agent-model-title" className="text-ui-body font-medium text-text">{t("settings.agent.activeModelTitle")}</h3>
          {onOpenModels && <button type="button" onClick={onOpenModels} className="flex min-h-9 items-center gap-2 rounded-input px-2 text-ui-caption text-link hover:bg-surface-hover">{t("settings.redesign.manageModels")}<ArrowRight size={14} /></button>}
        </div>
        <p className="mt-3 break-words text-ui-title font-medium text-text">{selectedModel?.label || config.unavailable_model || config.model || t("settings.agent.noModel")}</p>
        <p className="mt-1 text-ui-caption text-muted">{t("settings.redesign.modelSelectionHelp")}</p>
        {config.unavailable_model && <p role="alert" className="mt-3 text-ui-caption text-error-text">{t("settings.redesign.modelUnavailable")}</p>}
        <dl className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <div><dt className="text-ui-caption text-muted">{t("settings.redesign.contextWindow")}</dt><dd className="mt-1 font-mono text-ui-body text-text">{contextWindow ? t("settings.redesign.tokens", { count: contextWindow }) : t("settings.redesign.unknown")}</dd></div>
          <div><dt className="text-ui-caption text-muted">{t("settings.redesign.thinking")}</dt><dd className="mt-1 text-ui-body text-text">{selectedModel?.thinking_levels.includes(config.thinking) ? t(`settings.thinking.${config.thinking}`, { defaultValue: config.thinking }) : t("settings.redesign.unknown")}</dd></div>
        </dl>
        {selectedModel && <div className="mt-4 flex flex-wrap gap-2">
          {selectedModel.reasoning && <span className="flex items-center gap-1 rounded-input bg-surface-2 px-2 py-1 text-ui-caption text-muted"><BrainCircuit size={14} />{t("settings.redesign.reasoning")}</span>}
          {selectedModel.vision && <span className="flex items-center gap-1 rounded-input bg-surface-2 px-2 py-1 text-ui-caption text-muted"><Image size={14} />{t("settings.redesign.images")}</span>}
          {selectedModel.tools && <span className="flex items-center gap-1 rounded-input bg-surface-2 px-2 py-1 text-ui-caption text-muted"><Wrench size={14} />{t("settings.redesign.tools")}</span>}
        </div>}
      </section>
      <ContextManagementSection config={config} saving={saving} onSave={onSave} />
    </div>
  );
}
