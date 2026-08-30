import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolCallBlock } from "../../types/thread";
import { executionActivities, executionOperationCount } from "../../lib/conversation/activity-policy";
import { ACTIVITY_SWITCH_DEBOUNCE_MS, MIN_ACTIVITY_VISIBLE_MS, selectDisplayedActivity, type PresentedActivity } from "../../lib/conversation/activity-display-policy";
import { presentToolActivity } from "../../lib/conversation/activity-presenters";
import { cn } from "../../lib/ui";

const PHASE_LABEL_KEYS: Record<string, string> = {
  inspect: "conversation.activity.phase.inspect",
  research: "conversation.activity.phase.research",
  edit: "conversation.activity.phase.edit",
  execute: "conversation.activity.phase.execute",
  verify: "conversation.activity.phase.verify",
  compute: "conversation.activity.phase.compute",
  other: "conversation.activity.phase.other",
};

export function AgentActivity({ blocks, completed = false }: { blocks: ToolCallBlock[]; completed?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const activities = useMemo(() => executionActivities(blocks), [blocks]);
  const count = useMemo(() => executionOperationCount(blocks), [blocks]);
  const failures = useMemo(() => activities.filter((block) => block.status === "error").length, [activities]);
  const shown = useDisplayedActivity(blocks, completed);
  if (!shown && activities.length === 0) return null;
  const state = shown?.phase === "wait" ? "waiting" : shown?.phase === "error" ? "error" : shown ? "running" : failures > 0 ? "error" : "completed";
  const label = shown
    ? shown.phase === "wait"
      ? t("conversation.activity.waitingApproval")
      : shown.phase === "error"
        ? presentToolActivity(shown.source, t)
        : t(PHASE_LABEL_KEYS[shown.phase] ?? PHASE_LABEL_KEYS.other)
    : failures > 0
      ? t("conversation.activity.completedWithErrors", { count, failures })
      : t("conversation.activity.completed", { count });
  return <div id={blocks.length === 1 ? `thread-block-${blocks[0].id}` : undefined} data-thread-block-ids={blocks.map((block) => block.id).join(" ")} className="overflow-hidden rounded-input border border-faint bg-surface scroll-mt-4">
    <button type="button" aria-expanded={expanded} onClick={() => activities.length > 0 && setExpanded((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted transition-colors hover:bg-surface-2">
      <ActivityIcon state={state} />
      <span aria-live="polite" aria-atomic="true" className={cn("min-w-0 flex-1 truncate", state === "error" && "text-error-text")}>{label}</span>
      {activities.length > 0 && <ChevronRight size={13} aria-hidden className={cn("shrink-0 transition-transform", expanded && "rotate-90")} />}
    </button>
    {expanded && activities.length > 0 && <div className="border-t border-faint bg-surface-2/50 px-2 py-1" aria-label={t("conversation.activity.trace")}>{activities.map((block) => <TraceItem key={block.id} block={block} />)}</div>}
  </div>;
}

/** Keeps the Current Activity row stable: it changes only when the execution
 *  phase changes. Waiting and error states switch at once; everything else
 *  waits out the minimum-visible and switch-debounce windows. */
function useDisplayedActivity(blocks: ToolCallBlock[], completed: boolean): PresentedActivity | null {
  const target = completed ? null : selectDisplayedActivity(blocks);
  const [displayed, setDisplayed] = useState<PresentedActivity | null>(target);
  const shownAt = useRef(Date.now());
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (completed || !target) {
      setDisplayed(target);
      return;
    }
    if (!displayed || displayed.mergeKey !== target.mergeKey) {
      const immediate = !displayed || target.forced;
      if (immediate) {
        shownAt.current = Date.now();
        setDisplayed(target);
        return;
      }
      const delay = Math.max(ACTIVITY_SWITCH_DEBOUNCE_MS, MIN_ACTIVITY_VISIBLE_MS - (Date.now() - shownAt.current));
      const timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setDisplayed(targetRef.current);
      }, delay);
      return () => window.clearTimeout(timer);
    }
  }, [completed, displayed, target]);
  return displayed;
}

function ActivityIcon({ state }: { state: "waiting" | "running" | "error" | "completed" }) {
  if (state === "running") return <Loader2 size={13} aria-hidden className="shrink-0 animate-spin text-accent" />;
  if (state === "error") return <CircleX size={13} aria-hidden className="shrink-0 text-error-text" />;
  if (state === "waiting") return <span aria-hidden className="shrink-0 text-warn">!</span>;
  return <CircleCheck size={13} aria-hidden className="shrink-0 text-ok-text" />;
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
