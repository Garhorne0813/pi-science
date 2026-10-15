import { useEffect, useState } from "react";
import { ArrowRight, FlaskConical, MessageSquareText } from "lucide-react";
import { useNewWorkspaceConversation } from "../sidebar/workspace-navigation";
import { fileInspectorForPath } from "../../lib/artifacts";
import { useUiStore } from "../../lib/ui";
import { useTranslation } from "react-i18next";

import { projectMemoryApi, useMemoryArchives } from "../../lib/knowledge";
import { EmptyState } from "./EmptyState";

/** Knowledge only summarizes research. New workflows start in conversation and
 *  historical records are read-only and continuation belongs to Conversation. */
export function ResearchTab({ cwd, onError }: { cwd: string; onError: (message: string | null) => void }) {
  const { t } = useTranslation();
  const newConversation = useNewWorkspaceConversation(cwd);
  const openInspector = useUiStore((state) => state.openInspector);
  const archivesRead = useMemoryArchives(cwd);
  const archives = archivesRead.data?.archives ?? [];
  const loadError = archivesRead.error;
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (loadError) onError(loadError instanceof Error ? loadError.message : t("research.loadError"));
  }, [loadError, onError, t]);

  const openConversation = () => newConversation({ draft: "/skill:auto-research " });
  const continueArchive = (path: string) => newConversation({ draft: `/skill:auto-research Resume from the historical archive ${path}. Inspect saved results and original run/artifact references before creating a new evaluation protocol. Reuse valid completed experiments.` });

  const accessArchive = async (id: string, continueResearch: boolean) => {
    setExporting(true); onError(null);
    try {
      const { archive } = await projectMemoryApi.exportArchive(cwd, id);
      if (continueResearch) continueArchive(archive.path);
      else openInspector(fileInspectorForPath(archive.path, "history.json", undefined, cwd));
    } catch (error) { onError(error instanceof Error ? error.message : t("research.loadError")); }
    finally { setExporting(false); }
  };

  return (
    <div className="space-y-4">
      <section className="ui-card-flat flex flex-col gap-4 rounded-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text">{t("knowledge.researchTitle")}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{t("knowledge.researchConversationDescription")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" onClick={openConversation} className="flex min-h-10 items-center gap-2 rounded-input bg-accent-fill px-4 text-sm font-medium text-accent-fg">
            <MessageSquareText size={15} /> {t("research.startFromConversation")}
          </button>

        </div>
      </section>

      {archives.length === 0 ? (
        <EmptyState icon={<FlaskConical size={28} />} title={t("knowledge.researchEmpty")} text={t("knowledge.researchEmptyConversationText")} />
      ) : (
        <div className="space-y-3">
          {archives.map((archive) => (
            <div key={archive.id}><button type="button" disabled={exporting} onClick={() => void accessArchive(archive.id, false)} className="text-xs text-accent hover:underline">{archive.path}</button><button type="button" disabled={exporting} onClick={() => void accessArchive(archive.id, true)} className="ui-card-flat block w-full rounded-card p-5 text-left transition-colors hover:border-accent/40">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-text">{archive.title}</h3>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">{t(`research.status.${archive.status}`, { defaultValue: archive.status })}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted">{archive.objective}</p>
              <div className="mt-3 flex items-center gap-1 text-xs text-accent">{t("research.continueInConversation")} <ArrowRight size={12} /></div>
            </button></div>
          ))}
        </div>
      )}
    </div>
  );
}
