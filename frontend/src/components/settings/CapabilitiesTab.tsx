import { useTranslation } from "react-i18next";
import { Section } from "./Section";
import { SubagentSettings } from "./SubagentSettings";

export function CapabilitiesTab({ workspaceCwd, onOpenMcp }: { workspaceCwd: string | null; onOpenMcp: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-page pt-panel md:pt-4">
      <Section title={t("settings.capabilities.builtinTitle")}>
        <p className="text-ui-caption leading-relaxed text-muted">{t("settings.capabilities.builtinDescription")}</p>
      </Section>
      <Section title={t("settings.capabilities.webTitle")}>
        <p className="text-ui-caption leading-relaxed text-muted">{t("settings.capabilities.webDescription")}</p>
        <button type="button" onClick={onOpenMcp} className="mt-3 min-h-9 rounded-input px-3 text-ui-caption text-link hover:bg-surface-hover">
          {t("settings.capabilities.manageMcp")}
        </button>
      </Section>
      <SubagentSettings workspaceCwd={workspaceCwd} />
    </div>
  );
}
