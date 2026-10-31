import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { subagentsQuery } from "../../lib/settings";
import { Section } from "./Section";

export function SubagentSettings({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  const agentsRead = useQuery({ ...subagentsQuery(workspaceCwd ?? "", t("settings.subagents.loadError")), enabled: Boolean(workspaceCwd) });
  return (
    <Section title={t("settings.subagents.title")}>
      <p className="text-ui-caption leading-relaxed text-muted">{t(workspaceCwd ? "settings.subagents.coreDescription" : "settings.subagents.workspaceRequired")}</p>
      {workspaceCwd && <>
        <details className="mt-3"><summary className="cursor-pointer text-ui-label text-muted">{t("settings.consistency.configurationGuide")}</summary><pre className="mt-3 overflow-x-auto rounded-input bg-surface-2 p-3 text-ui-meta text-text">{".pi/agents/reviewer.md\n\n---\nname: reviewer\ndescription: Review scientific evidence\nexecution_scope: workspace\n---\nReview the evidence and explain its limitations."}</pre></details>
        {agentsRead.isPending && <p role="status" className="mt-3 text-ui-caption text-muted">{t("common.loading")}</p>}
        {agentsRead.error && <p role="alert" className="mt-3 text-ui-caption text-error-text">{agentsRead.error.message}</p>}
        {agentsRead.data && <ul className="mt-3 divide-y divide-faint border-y border-faint">
          {(agentsRead.data.agents ?? []).map((agent) => <li key={agent.name} className="py-2 text-ui-caption text-text"><span className="font-medium">{agent.name}</span><code className="mt-1 block break-all text-ui-meta text-muted">{agent.path}</code></li>)}
        </ul>}
      </>}
    </Section>
  );
}
