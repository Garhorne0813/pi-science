import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { extensionsQuery } from "../../lib/settings-api";
import { AgentProfilesSection } from "./AgentProfilesSection";
import { ExtCard } from "./ExtCard";
import { Section } from "./Section";
import { SubagentSettings } from "./SubagentSettings";
import { WebAccessSettings } from "./WebAccessSettings";

const EXTENSION_DESCRIPTION_KEYS: Record<string, string> = {
  "pi-mcp-adapter": "settings.extensionsPage.description.mcp",
  "pi-subagents": "settings.extensionsPage.description.subagents",
  "pi-web-access": "settings.extensionsPage.description.webAccess",
  "context-mode": "settings.extensionsPage.description.contextMode",
};

export function ExtensionsTab({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  const extensionsRead = useQuery(extensionsQuery(t("settings.extensionsPage.loadError")));
  const error = extensionsRead.error instanceof Error ? extensionsRead.error.message : null;
  const extensions = extensionsRead.isPending ? null : extensionsRead.data?.extensions || [];

  return (
    <div className="space-y-6">
      <Section title={t("settings.extensionsPage.title")}>
        <p className="text-[11px] text-muted mb-3">
          {t("settings.extensionsPage.descriptionPrefix")} <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">bash scripts/fetch-pi.sh</code> {t("settings.extensionsPage.descriptionSuffix")}
        </p>
        {error && (
          <p role="alert" className="mb-3 text-xs text-error">
            {error}
          </p>
        )}
        {extensions === null && !error && <p className="text-xs text-muted">{t("settings.extensionsPage.checking")}</p>}
        {extensions?.map((extension) => (
          <ExtCard key={extension.id} name={extension.name} pkg={extension.id} desc={EXTENSION_DESCRIPTION_KEYS[extension.id] ? t(EXTENSION_DESCRIPTION_KEYS[extension.id]) : extension.description} checked={extension.installed} />
        ))}
      </Section>
      <WebAccessSettings />
      <SubagentSettings workspaceCwd={workspaceCwd} />
      <AgentProfilesSection />
    </div>
  );
}
