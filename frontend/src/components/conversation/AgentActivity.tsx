import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolCallBlock } from "../../types/thread";
import { executionActivities, executionOperationCount } from "../../lib/conversation/activity-policy";
import { ACTIVITY_SWITCH_DEBOUNCE_MS, MIN_ACTIVITY_VISIBLE_MS, selectDisplayedActivity } from "../../lib/conversation/activity-display-policy";
import type { PresentedActivity } from "../../lib/conversation/activity-narrative";
import type { TurnLifecycle } from "../../lib/conversation/turn-presentation";
import { presentToolActivity } from "../../lib/conversation/activity-presenters";
import { ProgressVisual, useProgressAppearance } from "../progress/ProgressVisual";
import { cn } from "../../lib/ui";

export function AgentActivity({ blocks, lifecycle = "active" }: { blocks: ToolCallBlock[]; lifecycle?: TurnLifecycle }) {
  const { t } = useTranslation();
  const progressAppearance = useProgressAppearance();
  const [expanded, setExpanded] = useState(false);
  const activities = useMemo(() => executionActivities(blocks), [blocks]);
  const count = useMemo(() => executionOperationCount(blocks), [blocks]);
  const shown = useDisplayedActivity(blocks, lifecycle);
  if (!shown && activities.length === 0 && lifecycle !== "recovering" && lifecycle !== "waiting") return null;

  const canExpand = activities.length > 0;
  const traceOnly = !shown && (lifecycle === "queued" || lifecycle === "active" || lifecycle === "waiting" || lifecycle === "recovering");
  const state = lifecycle === "failed" || shown?.state === "error" ? "error" : lifecycle === "aborted" ? "stopped" : lifecycle === "settled" ? "completed" : shown?.state === "interaction" ? "waiting" : "running";
  const label = lifecycle === "failed"
    ? t("conversation.activity.error")
    : lifecycle === "aborted"
      ? t("conversation.activity.stopped")
      : lifecycle === "settled"
        ? t("conversation.activity.completed")
        : lifecycle === "recovering"
          ? t("conversation.activity.narrative.recover")
          : lifecycle === "waiting" && !shown
            ? t("conversation.activity.waitingInput")
            : shown
          ? narrativeLabel(shown, t)
          : t("conversation.activity.trace");

  return <div id={blocks.length === 1 ? `thread-block-${blocks[0].id}` : undefined} data-thread-block-ids={blocks.map((block) => block.id).join(" ")} className="overflow-hidden scroll-mt-4">
    <button type="button" aria-expanded={canExpand ? expanded : undefined} onClick={() => canExpand && setExpanded((value) => !value)} className={cn("flex w-full items-center gap-2 text-left text-xs text-muted transition-colors", canExpand && "hover:bg-surface-2", traceOnly ? "px-1 py-1" : "px-3 py-2")}>
      {!traceOnly && <ActivityIcon state={state} config={progressAppearance} label={label} />}
      <span {...(!traceOnly ? { "aria-live": "polite", "aria-atomic": "true" } : {})} className={cn("min-w-0 flex-1 truncate", state === "error" && "text-error-text")}>{label}</span>
      {lifecycle === "settled" && <span className="shrink-0 font-mono text-[10px] text-muted/60" aria-label={t("conversation.activity.operationCount", { count })}>{count}</span>}
      {canExpand && <ChevronRight size={13} aria-hidden className={cn("shrink-0 text-muted/60 transition-transform", expanded && "rotate-90")} />}
    </button>
    {expanded && canExpand && <div className="border-t border-faint bg-surface-2/50 px-2 py-1" aria-label={t("conversation.activity.trace")}>{activities.map((block) => <TraceItem key={block.id} block={block} />)}</div>}
  </div>;
}

/** Depend on the stable narrative key, not the changing activity object. This
 *  keeps high-frequency partial tool output from restarting the timer. */
function useDisplayedActivity(blocks: ToolCallBlock[], lifecycle: TurnLifecycle): PresentedActivity | null {
  const live = lifecycle === "queued" || lifecycle === "active" || lifecycle === "waiting" || lifecycle === "recovering";
  const target = live ? selectDisplayedActivity(blocks) : null;
  const targetKey = target?.mergeKey ?? null;
  const targetForced = target?.forced === true;
  const [displayed, setDisplayed] = useState<PresentedActivity | null>(target);
  const displayedKey = displayed?.mergeKey ?? null;
  const shownAt = useRef(Date.now());
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (!live || !targetKey) {
      setDisplayed(null);
      return;
    }
    if (displayedKey === targetKey) return;
    if (!displayedKey || targetForced) {
      shownAt.current = Date.now();
      setDisplayed(targetRef.current);
      return;
    }
    const delay = Math.max(ACTIVITY_SWITCH_DEBOUNCE_MS, MIN_ACTIVITY_VISIBLE_MS - (Date.now() - shownAt.current));
    const timer = window.setTimeout(() => {
      shownAt.current = Date.now();
      setDisplayed(targetRef.current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [displayedKey, live, targetForced, targetKey]);
  return displayed;
}

function narrativeLabel(activity: PresentedActivity, t: (key: string) => string): string {
  if (activity.state === "interaction") return t(activity.source.tool === "ask_user_question" ? "conversation.activity.waitingInput" : "conversation.activity.waitingApproval");
  if (activity.state === "error") return t("conversation.activity.error");
  if (activity.state === "recover") return t("conversation.activity.narrative.recover");
  const domainKey = `conversation.activity.narrative.${activity.state}.${activity.domain}`;
  const translated = t(domainKey);
  return translated === domainKey ? t(`conversation.activity.narrative.${activity.state}`) : translated;
}

function ActivityIcon({ state, config, label }: { state: "waiting" | "running" | "error" | "stopped" | "completed"; config: import("@pi-science/contracts").ProgressAppearance; label: string }) {
  if (state === "running") return <ProgressVisual slot="currentActivity" config={config} text={label} />;
  if (state === "waiting") return <ProgressVisual slot="waiting" config={config} state="waiting" text={label} />;
  if (state === "completed") return <ProgressVisual slot="completed" config={config} state="completed" text={label} />;
  if (state === "error" || state === "stopped") return <CircleX size={13} aria-hidden className={cn("shrink-0", state === "error" ? "text-error-text" : "text-muted")} />;
  return <span aria-hidden className="shrink-0 text-warn">!</span>;
}

function TraceItem({ block }: { block: ToolCallBlock }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(block.input || block.output || block.partialOutput || block.diff);
  const output = block.output || block.partialOutput;
  return <div className="border-b border-faint last:border-b-0">
    <button type="button" disabled={!hasDetails} aria-expanded={hasDetails ? expanded : undefined} onClick={() => hasDetails && setExpanded((value) => !value)} className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-xs text-muted hover:bg-surface disabled:cursor-default">
      {block.status === "running" ? <Loader2 size={12} aria-hidden className="animate-spin text-accent" /> : block.status === "error" ? <CircleX size={12} aria-hidden className="text-error-text" /> : <CircleCheck size={12} aria-hidden className="text-ok-text" />}
      <span className="min-w-0 flex-1 truncate">{presentToolActivity(block, t)}</span>
      {hasDetails && <ChevronRight size={12} aria-hidden className={cn("transition-transform", expanded && "rotate-90")} />}
    </button>
    {expanded && hasDetails && <div className="space-y-2 px-2 pb-2 pl-6 text-xs">
      <Detail label={t("conversation.activity.toolLabel")} value={block.tool} />
      {block.input && <Detail label={t("conversation.activity.input")} value={JSON.stringify(block.input, null, 2)} pre />}
      {output && <Detail label={t("conversation.activity.output")} value={output.slice(0, 8000)} pre />}
      {block.diff && <Detail label={t("conversation.activity.diff")} value={block.diff.slice(0, 8000)} pre />}
    </div>}
  </div>;
}
function Detail({ label, value, pre = false }: { label: string; value: string; pre?: boolean }) { return <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>{pre ? <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-input bg-surface px-2 py-1.5 font-mono text-xs leading-5 text-text">{value}</pre> : <div className="font-mono text-xs text-text">{value}</div>}</div>; }
