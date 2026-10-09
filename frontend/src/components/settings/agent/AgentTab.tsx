import { useTranslation } from "react-i18next";
import { ContextManagementSection } from "../ContextManagementSection";
import type { SettingsConfig } from "../../../lib/settings";
import { DefaultModelSelection } from "./DefaultModelSelection";

export function AgentTab({ config, loading, error, scope, saving, onSave, onRefreshContext, onOpenModels }: { config: SettingsConfig | null; loading: boolean; error: string | null; scope: string | null; saving: boolean; onSave: (enabled: boolean, threshold: number) => Promise<void>; onRefreshContext: () => Promise<void>; onOpenModels?: () => void }) {
  const { t } = useTranslation();
  return <div className="space-y-6">
    <p className="text-ui-caption leading-relaxed text-muted">{t("settings.agent.description")}</p>
    <DefaultModelSelection scope={scope} onCommitted={onRefreshContext} onOpenModels={onOpenModels} />
    <section aria-label={t("settings.context.title")} className="space-y-3">
      {loading && <p role="status" className="text-ui-caption text-muted">{t("settings.selection.contextLoading")}</p>}
      {error && <p role="alert" className="text-ui-caption text-error-text">{t("settings.selection.contextError", { error })}<button type="button" onClick={() => void onRefreshContext().catch(() => undefined)} className="ml-2 min-h-9 px-2 text-link">{t("settings.redesign.retryLoad")}</button></p>}
      {config && <ContextManagementSection config={config} saving={saving} onSave={onSave} />}
    </section>
  </div>;
}
