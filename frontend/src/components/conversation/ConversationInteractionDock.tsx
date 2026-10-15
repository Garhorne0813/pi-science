import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { hasActivePendingInteraction } from "../../lib/agent-runtime/types";
import type { PendingInteraction, PendingQuestionnaire } from "../../lib/agent-runtime";
import { QuestionnairePrompt } from "./QuestionnairePrompt";
import { InteractionPrompt } from "./InteractionPrompt";

type Response = { value?: string; confirmed?: boolean; cancelled?: boolean };
type Props = {
  interaction: PendingInteraction | null;
  questionnaire: PendingQuestionnaire | null;
  onRespond: (response: Response) => void | Promise<void>;
  onComplete?: () => void;
};
export function ConversationInteractionDock(props: Props) {
  const { t } = useTranslation();
  if (!hasActivePendingInteraction(props.interaction, props.questionnaire)) {
    return props.interaction || props.questionnaire ? <div className="shrink-0 px-4 pb-2 sm:px-8"><p role="status" className="mx-auto max-w-[var(--conversation-composer-width)] rounded-composer border border-border bg-surface px-4 py-3 text-sm text-muted">{t("interaction.preparing")}</p></div> : null;
  }
  return <InteractionDockContent key={JSON.stringify([props.interaction!.requestId, props.interaction!.toolCallId])} {...props} interaction={props.interaction!} />;
}
function InteractionDockContent({ interaction, questionnaire, onRespond, onComplete }: Props & { interaction: PendingInteraction }) {
  const { t } = useTranslation();
  const id = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [answered, setAnswered] = useState(0);
  const rootRef = useRef<HTMLElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    const current = document.activeElement;
    if (restoreFocus.current || current === document.body || current?.closest("[hidden]")) {
      if (collapsed) resumeRef.current?.focus({ preventScroll: true });
      else rootRef.current?.querySelector<HTMLElement>("h3, button, textarea")?.focus({ preventScroll: true });
    }
    restoreFocus.current = false;
  }, [collapsed]);
  const collapse = () => { restoreFocus.current = true; setCollapsed(true); };
  const respond = async (response: Response) => { await onRespond(response); onComplete?.(); };
  return (
    <section ref={rootRef} aria-label={t("interaction.waiting")} className="shrink-0 px-4 pb-2 sm:px-8" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        // A tooltip may prevent the native Escape default while returning focus.
        // Only the full details dialog owns Escape ahead of this question seat.
        const detailsOpen = rootRef.current?.querySelector('[aria-haspopup="dialog"][aria-expanded="true"]');
        if (!(event.target as HTMLElement).closest('[role="dialog"]') && !detailsOpen) { event.preventDefault(); collapse(); }
      }
    }}>
      <div className="mx-auto min-w-0 max-w-[var(--conversation-composer-width)]">
        {collapsed && <button ref={resumeRef} type="button" aria-expanded={false} aria-controls={id} onClick={() => { restoreFocus.current = true; setCollapsed(false); }} className="flex min-h-10 w-full items-center gap-2 rounded-composer border border-border bg-surface px-4 py-2 text-left text-xs text-muted hover:text-text">
          <span className="min-w-0 flex-1 break-words">{t("interaction.waiting")}{interaction.questionnaire && questionnaire && ` · ${t("questionnaire.progress", { answered, total: questionnaire.questions.length })}`}</span><span className="shrink-0">{t("interaction.expand")}</span><ChevronUp size={14} className="shrink-0" />
        </button>}
        <div id={id} hidden={collapsed}>
          {interaction.questionnaire && questionnaire ? <QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={respond} onProgress={setAnswered} onCollapse={collapse} active={!collapsed} /> : <>
            <div className="mb-1 flex items-center justify-between gap-3 px-3 text-xs text-muted"><span className="truncate">{interaction.title}</span><button type="button" aria-label={t("interaction.collapse")} onClick={collapse} className="rounded-input p-1 hover:bg-surface-2"><ChevronDown size={15} /></button></div>
            <div className="max-h-[50dvh] overflow-y-auto"><InteractionPrompt interaction={interaction} onRespond={respond} /></div>
          </>}
        </div>
      </div>
    </section>
  );
}
