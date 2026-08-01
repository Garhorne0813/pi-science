import { useEffect } from "react";
import { ArrowRight, FlaskConical, MessageSquareText } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useResearchLoops } from "../../lib/knowledge";
import { EmptyState } from "./EmptyState";

/** Knowledge only summarizes research. New workflows start in conversation and
 *  detailed lifecycle controls live on the workspace Research page. */
export function ResearchTab({ cwd, onError }: { cwd: string; onError: (message: string | null) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const loopsRead = useResearchLoops(cwd);
  const loops = loopsRead.data?.loops ?? [];
  const loadError = loopsRead.error;

  useEffect(() => {
    if (loadError) onError(loadError instanceof Error ? loadError.message : t("research.loadError"));
  }, [loadError, onError, t]);

  const openConversation = () => navigate(`/workspace/${encodeURIComponent(cwd)}`);
  const openResearch = () => navigate(`/workspace/${encodeURIComponent(cwd)}/research`);

  return (
    <div className="space-y-4">
      <section className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-serif text-lg text-text">{t("knowledge.researchTitle")}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{t("knowledge.researchConversationDescription")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" onClick={openConversation} className="flex min-h-10 items-center gap-2 rounded-input bg-accent px-4 text-sm font-medium text-accent-fg">
            <MessageSquareText size={15} /> {t("research.startFromConversation")}
          </button>
          <button type="button" onClick={openResearch} className="flex min-h-10 items-center gap-2 rounded-input border border-border px-4 text-sm text-muted hover:text-text">
            {t("research.details")} <ArrowRight size={14} />
          </button>
        </div>
      </section>

      {loops.length === 0 ? (
        <EmptyState icon={<FlaskConical size={28} />} title={t("knowledge.researchEmpty")} text={t("knowledge.researchEmptyConversationText")} />
      ) : (
        <div className="space-y-3">
          {loops.map((loop) => (
            <button key={loop.loop_id} type="button" onClick={openResearch} className="block w-full rounded-card border border-border bg-surface p-5 text-left shadow-card transition-colors hover:border-accent/40">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-text">{loop.title}</h3>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">{t(`research.status.${loop.status}`, { defaultValue: loop.status })}</span>
                <span className="rounded-full bg-accent/5 px-2 py-0.5 text-[10px] text-accent">{t(`research.mode.${loop.task_type ?? "research_loop"}.label`)}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted">{loop.objective}</p>
              <div className="mt-3 flex items-center gap-1 text-xs text-accent">{t("research.details")} <ArrowRight size={12} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
