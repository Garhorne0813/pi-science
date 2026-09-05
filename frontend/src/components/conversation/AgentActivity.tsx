import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, Check, CircleX } from "lucide-react";
import type { ProgressAppearance } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import type { AgentMessageBlock, ToolCallBlock } from "../../types/thread";
import { activityPolicy, executionOperationCount } from "../../lib/conversation/activity-policy";
import { ACTIVITY_SWITCH_DEBOUNCE_MS, MIN_ACTIVITY_VISIBLE_MS, selectDisplayedActivity } from "../../lib/conversation/activity-display-policy";
import type { PresentedActivity } from "../../lib/conversation/activity-narrative";
import type { TurnLifecycle } from "../../lib/conversation/turn-presentation";
import { presentToolActivity } from "../../lib/conversation/activity-presenters";
import { ProgressVisual, useProgressAppearance } from "../progress/ProgressVisual";
import type { ProgressActivityState } from "../progress/progress-activity-map";
import { cn } from "../../lib/ui";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import { parseSuggestions } from "../../lib/conversation";
import styles from "./AgentActivity.module.css";

export type ActivityBlock = AgentMessageBlock | ToolCallBlock;

export function ThinkingActivity({ className }: { className?: string }) {
  const { t } = useTranslation();
  const config = useProgressAppearance();
  const title = t("conversation.activity.thinking");
  const detail = t("conversation.activity.continuing");
  return <div data-state="running" data-motion={config.motion} style={activityStyle(config)} className={cn(styles.root, "flex w-full items-center gap-2 py-1", className)}>
    <span className={styles.glyph}><ProgressVisual slot="thinking" config={config} activityState="orient" text={title} /></span>
    <ActivityLabel title={title} detail={detail} />
  </div>;
}

export function AgentActivity({ blocks, lifecycle = "active", cwd }: { blocks: ActivityBlock[]; lifecycle?: TurnLifecycle; cwd?: string }) {
  const { t } = useTranslation();
  const progressAppearance = useProgressAppearance();
  const traceId = useId();
  const live = isLive(lifecycle);
  // Reset only when a run starts/ends. Tool updates and waiting/recovery must
  // preserve a user's choice, and completion must collapse even a manual open.
  const [disclosure, setDisclosure] = useState({ live, expanded: live });
  if (disclosure.live !== live) setDisclosure({ live, expanded: live });
  const expanded = disclosure.live === live ? disclosure.expanded : live;
  const tools = useMemo(() => blocks.filter((block): block is ToolCallBlock => block.kind === "tool"), [blocks]);
  const activities = useMemo(() => blocks.filter((block) => block.kind === "agent"
    ? Boolean(parseSuggestions(block.parts.map((part) => part.text).join("")).clean.trim())
    : activityPolicy(block).visibleInExecutionTrace), [blocks]);
  const count = useMemo(() => executionOperationCount(tools), [tools]);
  const shown = useDisplayedActivity(tools, lifecycle);
  if (!shown && activities.length === 0 && lifecycle !== "recovering" && lifecycle !== "waiting") return null;

  const canExpand = activities.length > 0;
  const state = lifecycle === "failed" || shown?.state === "error" ? "error" : lifecycle === "aborted" ? "stopped" : lifecycle === "settled" ? "completed" : lifecycle === "waiting" || shown?.state === "interaction" ? "waiting" : "running";
  const title = lifecycle === "failed"
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
              : t("conversation.activity.thinking");
  const task = lifecycle === "recovering"
    ? t("conversation.activity.recoveringDetail")
    : shown
      ? presentToolActivity(shown.source, t)
      : state === "running"
        ? t("conversation.activity.continuing")
        : null;
  const detail = task && task !== title ? task : null;
  const visualSlot = state === "waiting" ? "waiting" : shown ? "currentActivity" : "thinking";

  return <div id={blocks.length === 1 && blocks[0].kind === "tool" ? `thread-block-${blocks[0].id}` : undefined} data-thread-block-ids={blocks.map((block) => block.id).join(" ")} data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0 scroll-mt-4")}>
    <button type="button" disabled={!canExpand} aria-expanded={canExpand ? expanded : undefined} aria-controls={canExpand && expanded ? traceId : undefined} onClick={() => setDisclosure({ live, expanded: !expanded })} className={cn(styles.summary, "flex min-h-primary w-full items-center gap-2 rounded-input py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default sm:min-h-control")}>
      <span key={state} className={styles.glyph}><ActivityIcon state={state} slot={visualSlot} config={progressAppearance} label={title} activityState={activityStateFor(lifecycle, shown)} /></span>
      <ActivityLabel title={title} detail={detail} error={state === "error"} />
      {lifecycle === "settled" && count > 0 && <span className="shrink-0 font-mono text-ui-micro text-muted" aria-label={t("conversation.activity.operationCount", { count })}>{count}</span>}
      {canExpand && <ChevronRight size={13} aria-hidden className={cn(styles.chevron, "shrink-0 text-muted", expanded && "rotate-90")} />}
    </button>
    {expanded && canExpand && <div id={traceId} role="region" className={styles.trace} aria-label={t("conversation.activity.trace")}>{activities.map((block) => block.kind === "agent"
      ? <div key={block.id} id={`thread-block-${block.id}`} className={cn(styles.entry, styles.narration, "min-w-0")}><MarkdownViewer variant="chat" className="text-ui-body leading-relaxed text-muted [overflow-wrap:anywhere]" resourceContext={cwd ? { cwd } : undefined}>{parseSuggestions(block.parts.map((part) => part.text).join("")).clean}</MarkdownViewer></div>
      : <TraceItem key={block.id} block={block} live={live} />)}</div>}
  </div>;
}

function activityStyle(config: ProgressAppearance): CSSProperties {
  const speed = Number.isFinite(config.speed) && config.speed > 0 ? config.speed : 1;
  return {
    "--activity-color": config.colorMode === "custom" && config.customColor ? config.customColor : "var(--accent)",
    "--activity-cycle": `${3.2 / speed}s`,
    "--activity-beat": `${1.2 / speed}s`,
  } as CSSProperties;
}

function isLive(lifecycle: TurnLifecycle): boolean {
  return lifecycle === "queued" || lifecycle === "active" || lifecycle === "waiting" || lifecycle === "recovering";
}

/** Depend on the stable narrative key, not the changing activity object. This
 *  keeps high-frequency partial tool output from restarting the timer. */
function useDisplayedActivity(blocks: ToolCallBlock[], lifecycle: TurnLifecycle): PresentedActivity | null {
  const live = isLive(lifecycle);
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
  return live ? displayed : null;
}

function narrativeLabel(activity: PresentedActivity, t: (key: string) => string): string {
  if (activity.state === "interaction") return t(activity.source.tool === "ask_user_question" ? "conversation.activity.waitingInput" : "conversation.activity.waitingApproval");
  if (activity.state === "error") return t("conversation.activity.error");
  if (activity.state === "recover") return t("conversation.activity.narrative.recover");
  const domainKey = `conversation.activity.narrative.${activity.state}.${activity.domain}`;
  const translated = t(domainKey);
  return translated === domainKey ? t(`conversation.activity.narrative.${activity.state}`) : translated;
}

function ActivityLabel({ title, detail, error = false }: { title: string; detail: string | null; error?: boolean }) {
  return <span aria-live="polite" aria-atomic="true" className="flex min-w-0 flex-1 items-center">
    <span key={title} title={title} className={cn(styles.title, "min-w-0 truncate text-sm font-medium leading-5 text-text", error && "text-error-text")}>{title}</span>
    {detail && <><span aria-hidden className="mx-2 h-0.5 w-0.5 shrink-0 rounded-full bg-muted" /><span key={detail} className={cn(styles.detail, "min-w-0 flex-1 truncate text-xs font-normal leading-[18px] text-muted")}>{detail}</span></>}
  </span>;
}

function activityStateFor(lifecycle: TurnLifecycle, activity: PresentedActivity | null): ProgressActivityState {
  if (lifecycle === "recovering") return "recover";
  if (lifecycle === "waiting") return "interaction";
  return activity?.state ?? "orient";
}

function ActivityIcon({ state, slot, config, label, activityState }: { state: "waiting" | "running" | "error" | "stopped" | "completed"; slot: "thinking" | "currentActivity" | "waiting"; config: ProgressAppearance; label: string; activityState: ProgressActivityState }) {
  if (state === "running") return <ProgressVisual slot={slot} config={config} activityState={activityState} text={label} />;
  if (state === "waiting") return <ProgressVisual slot="waiting" config={config} state="waiting" activityState={activityState} text={label} />;
  if (state === "completed") return <ProgressVisual slot="completed" config={config} state="completed" text={label} />;
  if (state === "error" || state === "stopped") return <CircleX size={14} aria-hidden className={cn("shrink-0", state === "error" ? "text-error-text" : "text-muted")} />;
  return <span aria-hidden className="shrink-0 text-sm font-medium text-warn">!</span>;
}

function TraceItem({ block, live }: { block: ToolCallBlock; live: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(block.input || block.output || block.partialOutput || block.diff);
  const output = block.output || block.partialOutput;
  const running = live && block.status === "running";
  return <div className={cn(styles.entry, styles.tool)} data-running={running}>
    <button type="button" disabled={!hasDetails} aria-expanded={hasDetails ? expanded : undefined} onClick={() => hasDetails && setExpanded((value) => !value)} className={cn(styles.toolButton, "flex min-h-primary max-w-full items-center gap-2 rounded-input py-1.5 text-left text-ui-label text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default sm:min-h-control")}>
      {running ? <span aria-hidden className={styles.wave}><i /><i /><i /><i /></span> : block.status === "running" ? <CircleX size={14} aria-hidden className="shrink-0 text-muted" /> : block.status === "error" ? <CircleX size={14} aria-hidden className="shrink-0 text-error-text" /> : <Check size={14} aria-hidden className={cn(styles.toolCheck, "shrink-0 text-muted")} />}
      <span className="min-w-0 flex-1 truncate">{presentToolActivity(block, t)}</span>
      {hasDetails && <ChevronRight size={12} aria-hidden className={cn(styles.chevron, "shrink-0", expanded && "rotate-90")} />}
    </button>
    {expanded && hasDetails && <div className={cn(styles.details, "space-y-2 pb-2 pl-6 text-xs")}>
      <Detail label={t("conversation.activity.toolLabel")} value={block.tool} />
      {block.input && <Detail label={t("conversation.activity.input")} value={JSON.stringify(block.input, null, 2)} pre />}
      {output && <Detail label={t("conversation.activity.output")} value={output.slice(0, 8000)} pre />}
      {block.diff && <Detail label={t("conversation.activity.diff")} value={block.diff.slice(0, 8000)} pre />}
    </div>}
  </div>;
}
function Detail({ label, value, pre = false }: { label: string; value: string; pre?: boolean }) { return <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>{pre ? <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-input bg-surface px-2 py-1.5 font-mono text-xs leading-5 text-text">{value}</pre> : <div className="font-mono text-xs text-text">{value}</div>}</div>; }
