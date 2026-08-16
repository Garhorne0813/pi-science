import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { extensionsQuery } from "../../lib/settings";
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
  "rpiv-ask-user-question": "settings.extensionsPage.description.askUserQuestion",
};

export function ExtensionsTab({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  const extensionsRead = useQuery(extensionsQuery(t("settings.extensionsPage.loadError")));
  const error = extensionsRead.error instanceof Error ? extensionsRead.error.message : null;
  const extensions = extensionsRead.isPending ? null : extensionsRead.data?.extensions || [];

  return (
    <div className="space-y-page pt-panel md:pt-4">
      <Section title={t("settings.extensionsPage.title")}>
        {error && (
          <p role="alert" className="mb-panel text-ui-caption text-error-text">
            {error}
          </p>
        )}
        {extensions === null && !error && <p className="text-ui-caption text-muted">{t("settings.extensionsPage.checking")}</p>}
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
