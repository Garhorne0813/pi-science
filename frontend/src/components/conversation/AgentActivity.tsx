import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, CircleX, ChevronRight } from "lucide-react";
import type { ProgressAppearance } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import type { AgentMessageBlock, ThreadBlock, ToolCallBlock } from "../../types/thread";
import { activityPolicy, executionOperationCount } from "../../lib/conversation/activity-policy";
import { ACTIVITY_SWITCH_DEBOUNCE_MS, MIN_ACTIVITY_VISIBLE_MS, selectDisplayedActivity } from "../../lib/conversation/activity-display-policy";
import type { PresentedActivity } from "../../lib/conversation/activity-narrative";
import { groupActivityBlocks, type ActivityGroup } from "../../lib/conversation/activity-groups";
import { isLiveLifecycle, type TurnLifecycle } from "../../lib/conversation/turn-presentation";
import { presentToolActivity } from "../../lib/conversation/activity-presenters";
import { ProgressVisual, useProgressAppearance } from "../progress/ProgressVisual";
import type { ProgressActivityState } from "../progress/progress-activity-map";
import { cn } from "../../lib/ui";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import { parseSuggestions } from "../../lib/conversation";
import { selectActivityTask } from "../../lib/conversation/activity-task";
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

/** The turn activity presentation.
 *
 *  Live turns split into two parts so the caller can pin the progress status
 *  at the bottom of the streaming output (Codex-style status feed): `content`
 *  renders the chronological narration and tool lines, `status` renders the
 *  aggregate progress row. The default renders both in order.
 *
 *  Settled (and aborted/failed) turns collapse everything into the model's
 *  narration — the per-step records were part of the live stream only.
 *  Aborted and failed runs keep a state headline; a settled turn without an
 *  explicit final message says so instead of implying the answer vanished. */
export function AgentActivity({ blocks, contextBlocks = blocks, lifecycle = "active", cwd, part = "both" }: { blocks: ActivityBlock[]; contextBlocks?: ThreadBlock[]; lifecycle?: TurnLifecycle; cwd?: string; part?: "both" | "content" | "status" }) {
  const { t } = useTranslation();
  const progressAppearance = useProgressAppearance();
  const tools = useMemo(() => blocks.filter((block): block is ToolCallBlock => block.kind === "tool"), [blocks]);
  const activities = useMemo(() => blocks.filter((block) => block.kind === "agent"
    ? Boolean(parseSuggestions(block.parts.map((part) => part.text).join("")).clean.trim())
    : activityPolicy(block).visibleInExecutionTrace), [blocks]);
  const activityGroups = useMemo(() => groupActivityBlocks(blocks), [blocks]);
  const traceId = useId();
  const traceTools = useMemo(() => activities.filter((block): block is ToolCallBlock => block.kind === "tool"), [activities]);
  const shown = useDisplayedActivity(tools, lifecycle);
  const task = useMemo(() => selectActivityTask(contextBlocks), [contextBlocks]);
  // Settled turns collapse their tool steps behind the process summary row.
  const [traceExpanded, setTraceExpanded] = useState(false);

  if (isLiveLifecycle(lifecycle)) {
    const state = lifecycle === "waiting" || lifecycle === "stopping" || shown?.state === "interaction" ? "waiting" : "running";
    const title = lifecycle === "recovering"
      ? t("conversation.activity.narrative.recover")
      : lifecycle === "stopping"
        ? t("conversation.activity.stopping")
        : lifecycle === "waiting" && !shown
          ? t("conversation.activity.waitingInput")
          : task.responding
            ? t("conversation.activity.streaming")
            : shown
              ? narrativeLabel(shown, t)
              : t("conversation.activity.thinking");
    const visualSlot = shown ? "currentActivity" : "thinking";
    // The stream is always open while live: narration and tool lines render
    // chronologically, and the caller pins the status row after the answer.
    const content = activities.length === 0 ? null : (
      <div id={blocks.length === 1 && blocks[0].kind === "tool" ? `thread-block-${blocks[0].id}` : undefined} data-thread-block-ids={blocks.map((block) => block.id).join(" ")} data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0 scroll-mt-4")}>
        <div role="region" className={cn(styles.trace, styles.traceLive)} aria-label={t("conversation.activity.trace")}>
          <ActivityTrace groups={activityGroups} cwd={cwd} live />
        </div>
      </div>
    );
    const status = (
      <div data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0")}>
        {/* Same compact marker slot as the tool lines above, so the phase
            title aligns with the step labels. */}
        <div className="flex min-h-primary w-full items-center gap-2 py-1 text-left">
          <span key={state} className="mx-1 flex w-3.5 shrink-0 justify-center"><ActivityIcon state={state} slot={visualSlot} config={progressAppearance} compact label={title} activityState={activityStateFor(lifecycle, shown)} /></span>
          <ActivityLabel title={title} detail={null} error={false} />
          <LiveElapsed live />
        </div>
      </div>
    );
    if (part === "content") return content;
    if (part === "status") return status;
    return <>{content}{status}</>;
  }

  if (activities.length === 0) return null;

  // Settled (and aborted/failed) turns keep the model's narration — the
  // per-step records were part of the live stream only. Aborted and failed
  // runs keep a state headline; a settled turn without an explicit final
  // message says so instead of implying the answer went missing.
  const narrationBlocks = activities.filter((block): block is AgentMessageBlock => block.kind === "agent");
  const hasExplicitFinal = blocks.some((block) => block.kind === "agent" && block.presentationRole === "final");
  const noAnswer = lifecycle === "settled" && !hasExplicitFinal && blocks.some((block) => block.kind === "agent" && block.presentationRole === "intermediate");
  const state = lifecycle === "failed" || shown?.state === "error" ? "error" : lifecycle === "aborted" ? "stopped" : "completed";
  const headline = lifecycle === "failed"
    ? t("conversation.activity.error")
    : lifecycle === "aborted"
      ? t("conversation.activity.stopped")
      : noAnswer
        ? t("conversation.activity.noAnswer")
        : null;

  const title = lifecycle === "failed"
    ? t("conversation.activity.error")
    : t("conversation.activity.stopped");
  const failureCount = traceTools.filter((block) => block.status === "error" || block.statusHistory?.includes("error")).length;
  const headerSegments = [
    t("conversation.activity.operationCount", { count: executionOperationCount(traceTools) }),
    formatProcessDuration(traceTools),
  ].filter(Boolean);
  // failureSummary carries its own separator.
  const failureSuffix = failureCount > 0 ? t("conversation.activity.failureSummary", { count: failureCount }) : "";
  const summary = t("conversation.activity.processHeader")
    + (headerSegments.length ? ` · ${headerSegments.join(" · ")}` : "")
    + failureSuffix;
  // Settled steps fold inside this row; aborted and failed turns show their
  // state headline instead.
  const summaryLabel = `${lifecycle === "settled" ? summary : title}${noAnswer ? ` · ${t("conversation.activity.noAnswer")}` : ""}`;

  return <div id={blocks.length === 1 && blocks[0].kind === "tool" ? `thread-block-${blocks[0].id}` : undefined} data-thread-block-ids={blocks.map((block) => block.id).join(" ")} data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0 scroll-mt-4")}>
    {narrationBlocks.map((block) => (
      <div key={block.id} id={`thread-block-${block.id}`} className={cn(styles.entry, styles.narration, "min-w-0")}><MarkdownViewer variant="chat" className="text-ui-body leading-relaxed text-muted [overflow-wrap:anywhere]" resourceContext={cwd ? { cwd } : undefined}>{parseSuggestions(block.parts.map((part) => part.text).join("")).clean}</MarkdownViewer></div>
    ))}
    {traceTools.length > 0 || headline ? (
      <button type="button" aria-expanded={traceExpanded} aria-controls={traceId} onClick={() => setTraceExpanded((value) => !value)} className={cn(styles.summary, "flex min-h-primary w-full items-center gap-2 rounded-input py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-control")}>
        <span className="min-w-0 flex-1 truncate text-ui-caption text-muted">{traceTools.length > 0 ? summaryLabel : headline}</span>
        {lifecycle === "settled" && <span className="sr-only" aria-live="polite">{t("conversation.activity.completed")}</span>}
        <ChevronRight size={13} aria-hidden className={cn(styles.chevron, "shrink-0 text-muted", traceExpanded && "rotate-90")} />
      </button>
    ) : null}
    {traceExpanded && traceTools.length > 0 && <div id={traceId} role="region" className={styles.trace} aria-label={t("conversation.activity.trace")}>
      <ActivityTrace groups={activityGroups} cwd={cwd} />
    </div>}
  </div>;
}

/** Chronological narration and tool lines. Live turns show the running
 *  tool's pulsing dot; the exploration group carries its own running tally. */
function ActivityTrace({ groups, cwd, live = false }: { groups: ActivityGroup[]; cwd?: string; live?: boolean }) {
  return <>
    {groups.map((group) => {
      const entries = group.blocks.map((block) => block.kind === "agent"
        ? <div key={block.id} id={`thread-block-${block.id}`} className={cn(styles.entry, styles.narration, "min-w-0")}><MarkdownViewer variant="chat" className="text-ui-body leading-relaxed text-muted [overflow-wrap:anywhere]" resourceContext={cwd ? { cwd } : undefined}>{parseSuggestions(block.parts.map((part) => part.text).join("")).clean}</MarkdownViewer></div>
        : <TraceItem key={block.id} block={block} live={live} />);
      if (group.kind !== "exploration" || group.blocks.length < 2) return entries;
      return <div key={group.id} data-activity-group-id={group.id} className={cn(styles.entry, "min-w-0")}>
        <GroupSummary group={group} live={live} />
        {entries}
      </div>;
    })}
  </>;
}

function GroupSummary({ group, live }: { group: ActivityGroup; live: boolean }) {
  const { t } = useTranslation();
  const done = group.blocks.filter((block) => block.kind === "tool" && block.status !== "running").length;
  const label = live
    ? t("conversation.activity.exploreSummaryLive", { done, count: group.blocks.length })
    : t("conversation.activity.exploreSummary", { count: group.blocks.length });
  return <div className="mb-0.5 text-ui-micro text-muted">{label}</div>;
}

function activityStyle(config: ProgressAppearance): CSSProperties {
  return {
    "--activity-color": config.colorMode === "custom" && config.customColor ? config.customColor : "var(--accent)",
  } as CSSProperties;
}

/** Depend on the stable narrative key, not the changing activity object. This
 *  keeps high-frequency partial tool output from restarting the timer. */
function useDisplayedActivity(blocks: ToolCallBlock[], lifecycle: TurnLifecycle): PresentedActivity | null {
  const live = isLiveLifecycle(lifecycle);
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
  return live ? target?.mergeKey === displayed?.mergeKey ? target : displayed : null;
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
  return <span aria-live="polite" aria-atomic="true" className={styles.label}>
    <span className={cn(styles.title, "text-text", error && "text-error-text")}>{title}</span>
    {detail && <span className={cn(styles.detail, "text-muted")}>{detail}</span>}
  </span>;
}

/** Self-ticking turn clock. Lives in its own component so the 4 Hz tick
 *  re-renders only this chip, never the activity row's narration tree. */
function LiveElapsed({ live }: { live: boolean }) {
  const [, tick] = useState(0);
  const startedAt = useRef<number | null>(null);
  if (live && startedAt.current === null) startedAt.current = Date.now();
  if (!live) startedAt.current = null;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [live]);
  if (!live || startedAt.current === null) return null;
  return <span aria-hidden="true" className="shrink-0 font-mono text-ui-micro tabular-nums text-muted">{formatSeconds(Math.max(0, (Date.now() - startedAt.current) / 1000))}</span>;
}

function formatSeconds(totalSeconds: number): string {
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
  if (totalSeconds < 60) return `${Math.floor(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${String(Math.floor(totalSeconds % 60)).padStart(2, "0")}s`;
}

function stepDuration(block: ToolCallBlock): string | null {
  if (!block.startedAt || !block.endedAt) return null;
  const start = Date.parse(block.startedAt);
  const end = Date.parse(block.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return formatSeconds(Math.max(0, (end - start) / 1000));
}

function formatProcessDuration(blocks: ToolCallBlock[]): string | null {
  const starts = blocks.map((block) => block.startedAt ? Date.parse(block.startedAt) : Number.NaN).filter(Number.isFinite);
  const ends = blocks.map((block) => block.endedAt ? Date.parse(block.endedAt) : Number.NaN).filter(Number.isFinite);
  if (starts.length === 0 || ends.length === 0) return null;
  return formatSeconds(Math.max(0, (Math.max(...ends) - Math.min(...starts)) / 1000));
}

function activityStateFor(lifecycle: TurnLifecycle, activity: PresentedActivity | null): ProgressActivityState {
  if (lifecycle === "recovering") return "recover";
  if (lifecycle === "waiting") return "interaction";
  return activity?.state ?? "orient";
}

/** The live status marker uses the same compact slot as the running tool
 *  line's dot, so the phase title aligns with the step labels above. */
function ActivityIcon({ state, slot, config, label, activityState, compact = false }: { state: "waiting" | "running" | "error" | "stopped" | "completed"; slot: "thinking" | "currentActivity" | "waiting"; config: ProgressAppearance; label: string; activityState: ProgressActivityState; compact?: boolean }) {
  if (state === "running") return <ProgressVisual slot={slot} config={config} activityState={activityState} compact={compact} text={label} />;
  if (state === "waiting") return <ProgressVisual slot="waiting" config={config} state="waiting" compact={compact} activityState={activityState} text={label} />;
  if (state === "completed") return <ProgressVisual slot="completed" config={config} state="completed" compact={compact} text={label} />;
  if (state === "error" || state === "stopped") return <CircleX size={14} aria-hidden className={cn("shrink-0", state === "error" ? "text-error-text" : "text-muted")} />;
  return <span aria-hidden className="shrink-0 text-sm font-medium text-warn">!</span>;
}

function TraceItem({ block, live }: { block: ToolCallBlock; live: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(block.input || block.output || block.partialOutput || block.diff);
  const output = block.output ?? block.partialOutput;
  const running = live && block.status === "running";
  const duration = running ? null : stepDuration(block);
  return <div className={cn(styles.entry, styles.tool)} data-running={running}>
    <button type="button" disabled={!hasDetails} aria-expanded={hasDetails ? expanded : undefined} onClick={() => hasDetails && setExpanded((value) => !value)} className={cn(styles.toolButton, "flex min-h-primary max-w-full items-center gap-2 rounded-input py-1.5 text-left text-ui-label text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default sm:min-h-control")}>
      {running ? <span aria-hidden className="mx-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : block.status === "error" ? <CircleX size={14} aria-hidden className="shrink-0 text-error-text" /> : <Check size={14} aria-hidden className="shrink-0 text-muted" />}
      <span className="min-w-0 flex-1 truncate">{presentToolActivity(block, t)}</span>
      {duration && <span aria-hidden="true" className="shrink-0 font-mono text-[10px] tabular-nums text-muted">{duration}</span>}
      {hasDetails && <ChevronRight size={12} aria-hidden className={cn("shrink-0 transition-transform", expanded && "rotate-90")} />}
    </button>
    {expanded && hasDetails && <div className={cn(styles.details, "space-y-2 pb-2 pl-6 text-xs")}>
      <Detail label={t("conversation.activity.toolLabel")} value={block.tool} />
      {block.input && <Detail label={t("conversation.activity.input")} value={JSON.stringify(block.input, null, 2)} pre />}
      {output && <OutputDetail label={t("conversation.activity.output")} value={output} fullValue={block.output} partial={Boolean(block.partialOutput && !block.output)} t={t} />}
      {block.diff && <OutputDetail label={t("conversation.activity.diff")} value={block.diff} fullValue={block.diff} t={t} />}
    </div>}
  </div>;
}

const DETAIL_PREVIEW_LIMIT = 8_000;

function OutputDetail({
  label,
  value,
  fullValue,
  partial = false,
  t,
}: {
  label: string;
  value: string;
  fullValue?: string;
  partial?: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [showFull, setShowFull] = useState(false);
  const truncated = value.length > DETAIL_PREVIEW_LIMIT;
  const canShowFull = Boolean(fullValue && fullValue.length > DETAIL_PREVIEW_LIMIT);
  const rendered = showFull && canShowFull ? fullValue! : value.slice(0, DETAIL_PREVIEW_LIMIT);
  return <div>
    <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-input bg-surface px-2 py-1.5 font-mono text-xs leading-5 text-text">{rendered}</pre>
    {truncated && <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted">
      <span>{t("conversation.activity.previewTruncated", { count: DETAIL_PREVIEW_LIMIT })}</span>
      {canShowFull
        ? <button type="button" onClick={() => setShowFull((current) => !current)} className="underline underline-offset-2 hover:text-text">{t("conversation.activity.fullOutput")}{showFull ? " ↑" : " ↓"}</button>
        : <span>{t("conversation.activity.fullOutputUnavailable")}</span>}
    </div>}
    {partial && !truncated && <div className="mt-1 text-[10px] text-muted">{t("conversation.activity.fullOutputUnavailable")}</div>}
  </div>;
}
function Detail({ label, value, pre = false }: { label: string; value: string; pre?: boolean }) { return <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>{pre ? <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-input bg-surface px-2 py-1.5 font-mono text-xs leading-5 text-text">{value}</pre> : <div className="font-mono text-xs text-text">{value}</div>}</div>; }
