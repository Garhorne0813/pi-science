import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Brain, Check, CircleX, ChevronRight, Copy, ExternalLink, FilePenLine, FolderSearch, Search, Terminal } from "lucide-react";
import { selectToolProgressDisplay, type ProgressAppearance } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import type { AgentMessageBlock, ThinkingBlock, ToolCallBlock } from "../../types/thread";
import { activityPolicy } from "../../lib/conversation/activity-policy";
import { ACTIVITY_SWITCH_DEBOUNCE_MS, MIN_ACTIVITY_VISIBLE_MS, selectDisplayedActivity } from "../../lib/conversation/activity-display-policy";
import type { PresentedActivity } from "../../lib/conversation/activity-narrative";
import { groupActivityBlocks, type ActivityGroup } from "../../lib/conversation/activity-groups";
import { formatBytes } from "../../lib/conversation/tool-progress-format";
import { isLiveLifecycle, type TurnLifecycle } from "../../lib/conversation/turn-presentation";
import { projectToolActivity } from "../../lib/conversation/projection";
import { ProgressVisual, useProgressAppearance } from "../progress/ProgressVisual";
import type { ProgressActivityState } from "../progress/progress-activity-map";
import { cn } from "../../lib/ui";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import { DiffView } from "../code-viewer/DiffView";
import { parseSuggestions } from "../../lib/conversation";
import { activityRendererRegistry } from "./activity-renderers/registry";
import { ActivityCategoryIcon } from "./activity-renderers/ActivityCategoryIcon";
import { toolErrorSummary, toolFilePath } from "./activity-renderers/shared";
import { pinnedFileInspector } from "../../lib/artifacts";
import { revealWorkspaceFile } from "../../lib/files";
import { toWorkspaceRelativePath } from "../../lib/files/workspace-path";
import { useUiStore } from "../../lib/ui";
import styles from "./AgentActivity.module.css";

export type ActivityBlock = AgentMessageBlock | ThinkingBlock | ToolCallBlock;

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
 *  Settled (and aborted/failed) turns collapse the complete process trace —
 *  intermediate narration, reasoning, and tools — behind one summary. The
 *  final answer is owned by ConversationTurn and rendered outside this
 *  component. A settled turn without a final answer says so explicitly. */
export function AgentActivity({ blocks, lifecycle = "active", cwd, part = "both", hasFinalAnswer, turnStartedAt, turnEndedAt }: { blocks: ActivityBlock[]; lifecycle?: TurnLifecycle; cwd?: string; part?: "both" | "content" | "status"; hasFinalAnswer?: boolean; turnStartedAt?: string; turnEndedAt?: string }) {
  const { t } = useTranslation();
  const progressAppearance = useProgressAppearance();
  // The turn already handed us the filtered activity blocks, so one pass is
  // enough: tool list for the displayed-activity policy, visible narration and
  // tools, and the visibility set the single grouping pass below reuses.
  const { tools, activities, visibleToolIds } = useMemo(() => {
    const toolBlocks: ToolCallBlock[] = [];
    const visibleBlocks: ActivityBlock[] = [];
    const visible = new Set<string>();
    for (const block of blocks) {
      if (block.kind === "tool") {
        toolBlocks.push(block);
        if (activityPolicy(block).visibleInExecutionTrace) {
          visible.add(block.id);
          visibleBlocks.push(block);
        }
      } else if (block.kind === "agent") {
        if (parseSuggestions(block.parts.map((part) => part.text).join("")).clean.trim()) visibleBlocks.push(block);
      } else if (block.parts.some((part) => part.text.trim())) {
        visibleBlocks.push(block);
      }
    }
    return { tools: toolBlocks, activities: visibleBlocks, visibleToolIds: visible };
  }, [blocks]);
  const groups = useMemo(() => groupActivityBlocks(blocks, visibleToolIds), [blocks, visibleToolIds]);
  // Final answers are rendered by ConversationTurn. Everything else is
  // process history and collapses together once the turn is terminal.
  const trace = useMemo(() => {
    const traceBlocks: ActivityBlock[] = [];
    const traceTools: ToolCallBlock[] = [];
    for (const block of activities) {
      if (block.kind === "agent" && block.presentationRole === "final") continue;
      traceBlocks.push(block);
      if (block.kind === "tool") traceTools.push(block);
    }
    return { blocks: traceBlocks, tools: traceTools };
  }, [activities]);
  const traceBlocks = trace.blocks;
  const traceTools = trace.tools;
  const traceGroups = useMemo(() => groupActivityBlocks(traceBlocks), [traceBlocks]);
  const shown = useDisplayedActivity(tools, lifecycle);
  const traceId = useId();
  const [traceExpanded, setTraceExpanded] = useState(false);

  // Keep the queued status row even though `queued` is no longer a live
  // lifecycle: it reports that the message waits in the queue, not a trace.
  if (isLiveLifecycle(lifecycle) || lifecycle === "queued") {
    const state = lifecycle === "queued" || lifecycle === "waiting" || lifecycle === "stopping" || shown?.state === "interaction" ? "waiting" : "running";
    // Running tense of the process label. The latest partial thinking block
    // takes the phase while the model is reasoning (no tool has taken over).
    const lastActivity = activities.at(-1);
    const thinkingLive = lastActivity?.kind === "thinking" && lastActivity.partial === true;
    const title = lifecycle === "queued"
      ? t("conversation.activity.queued")
      : lifecycle === "recovering"
      ? t("conversation.activity.narrative.recover")
      : lifecycle === "waiting" && !shown
        ? t("conversation.activity.waitingInput")
        : shown?.state === "interaction"
          ? t(shown.source.tool === "ask_user_question" ? "conversation.activity.waitingInput" : "conversation.activity.waitingApproval")
          : lifecycle === "stopping"
            ? t("conversation.activity.stopping")
            : thinkingLive
              ? t("conversation.activity.thinking")
              : t("conversation.activity.processLive");
    // The row names the phase, not just the fact that something runs: the
    // narrative states already describe the trace groups, and reusing them
    // keeps the status line and the steps above from disagreeing. Lifecycle
    // titles such as recovering already are the narrative, so skip a repeat.
    const narrative = shown
      ? t(`conversation.activity.narrative.${shown.state}.${shown.domain}`, { defaultValue: "" })
        || t(`conversation.activity.narrative.${shown.state}`, { defaultValue: "" })
      : "";
    const narrativeDetail = narrative && narrative !== title ? narrative : null;
    const visualSlot = shown ? "currentActivity" : "thinking";
    // The stream is always open while live: narration and tool lines render
    // chronologically, and the caller pins the status row after the answer.
    const content = lifecycle === "queued" || activities.length === 0 ? null : (
      <div id={blocks.length === 1 && blocks[0].kind === "tool" ? `thread-block-${blocks[0].id}` : undefined} data-thread-block-ids={blocks.map((block) => block.id).join(" ")} data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0 scroll-mt-4")}>
        <div role="region" className={cn(styles.trace, styles.traceLive)} aria-label={t("conversation.activity.trace")}>
          <ActivityTrace groups={groups} cwd={cwd} live />
        </div>
      </div>
    );
    const status = (
      <div data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0")}>
        {/* Same compact marker slot as the tool lines above, so the phase
            title aligns with the step labels: 14px slot at the 24px gutter,
            no side margin, 8px gap. Measured, that puts the title at x46, the
            same edge as every step label; the clock sits after the phase word.
            The 8px padding plus the 24px label line is exactly the 40px
            min-height, so the row does not grow. */}
        <div className="flex min-h-primary w-full items-center gap-2 py-2 text-left">
          <span key={state} className="flex w-3.5 shrink-0 justify-center"><ActivityIcon state={state} slot={visualSlot} config={progressAppearance} compact label={title} activityState={activityStateFor(lifecycle, shown)} /></span>
          <ActivityLabel title={title} detail={narrativeDetail} error={false} elapsed={<LiveElapsed live turnStartedAt={turnStartedAt} />} />
        </div>
      </div>
    );
    if (part === "content") return content;
    if (part === "status") return status;
    return <>{content}{status}</>;
  }

  // Callers that render the final answer outside this component
  // (ConversationTurn) pass the flag down; direct renders scan the blocks.
  const hasExplicitFinal = hasFinalAnswer ?? blocks.some((block) => block.kind === "agent" && block.presentationRole === "final");
  // A terminal result supplies trustworthy boundaries even without an answer.
  const wholeTurnDuration = ((lifecycle === "settled" && hasExplicitFinal) || lifecycle === "aborted" || lifecycle === "failed")
    ? formatTimestampDuration(turnStartedAt, turnEndedAt)
    : null;

  if (activities.length === 0) {
    // Nothing folded away, but a plan-only or answer-only turn still carries a
    // measurable turn duration worth showing.
    if (!wholeTurnDuration) return null;
    const completed = t(lifecycle === "aborted" ? "conversation.activity.stopped" : lifecycle === "failed" ? "conversation.activity.error" : "conversation.activity.completed");
    return <div data-state={lifecycle === "aborted" ? "stopped" : lifecycle === "failed" ? "error" : "completed"} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0 scroll-mt-4")}>
      <span role="status" aria-label={`${completed}. ${t("conversation.activity.turnDuration", { duration: wholeTurnDuration })}`} className={cn(styles.summary, "flex min-h-primary w-full items-center py-1 text-sm font-medium text-text")}>{completed} · {wholeTurnDuration}</span>
    </div>;
  }

  // A settled turn can legitimately contain only commentary/process narration.
  // Keep that history recoverable in the fold, but make the missing answer
  // explicit instead of promoting commentary into the answer slot.
  const hasNarration = traceBlocks.some((block) => block.kind === "agent");
  const noAnswer = lifecycle === "settled" && !hasExplicitFinal && hasNarration;
  const state = lifecycle === "aborted" ? "stopped" : lifecycle === "failed" || shown?.state === "error" ? "error" : "completed";
  const headline = lifecycle === "failed"
    ? t("conversation.activity.error")
    : lifecycle === "aborted"
      ? t("conversation.activity.stopped")
      : noAnswer
        ? t("conversation.activity.noAnswer")
        : null;

  const failureCount = traceTools.filter((block) => block.status === "error" || block.statusHistory?.includes("error")).length;
  // The step records fold inside the row; the label leads with the state and
  // adds only what the folded records cannot show: the overall process time
  // and failures.
  const stateLabel = lifecycle === "failed"
    ? t("conversation.activity.error")
    : lifecycle === "aborted"
      ? t("conversation.activity.stopped")
      : t("conversation.activity.completed");
  const processDuration = wholeTurnDuration ?? formatProcessDuration(traceBlocks, turnStartedAt, turnEndedAt);
  const durationDescription = processDuration
    ? t(wholeTurnDuration ? "conversation.activity.turnDuration" : "conversation.activity.processDuration", { duration: processDuration })
    : null;
  // failureSummary carries its own separator; the failed headline already
  // says the run went wrong.
  const failureSuffix = lifecycle !== "failed" && failureCount > 0 ? t("conversation.activity.failureSummary", { count: failureCount }) : "";
  const summaryLabel = `${stateLabel}${processDuration ? ` · ${processDuration}` : ""}${failureSuffix}${noAnswer ? ` · ${t("conversation.activity.noAnswer")}` : ""}`;

  return <div id={blocks.length === 1 && blocks[0].kind === "tool" ? `thread-block-${blocks[0].id}` : undefined} data-thread-block-ids={blocks.map((block) => block.id).join(" ")} data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0 scroll-mt-4")}>
    {traceBlocks.length > 0 ? (
      <button type="button" aria-label={durationDescription ? `${summaryLabel}. ${durationDescription}` : undefined} aria-expanded={traceExpanded} aria-controls={traceId} onClick={() => setTraceExpanded((value) => !value)} className={cn(styles.summary, styles.summaryButton, "flex min-h-primary w-full items-center gap-2 rounded-input py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-control")}>
        <span aria-live="polite" aria-atomic="true" className="min-w-0 flex-1 truncate text-sm font-medium text-text">{summaryLabel}</span>
        <ChevronRight size={12} aria-hidden className={cn(styles.chevron, "shrink-0 text-muted", traceExpanded && "rotate-90")} />
      </button>
    ) : headline ? (
      <div aria-live="polite" aria-atomic="true" className={cn(styles.summary, "flex min-h-primary w-full items-center py-1 text-sm font-medium text-text")}>{headline}</div>
    ) : null}
    {traceExpanded && traceBlocks.length > 0 && <div id={traceId} role="region" className={cn(styles.trace, styles.traceOpen)} aria-label={t("conversation.activity.trace")}>
      <ActivityTrace groups={traceGroups} cwd={cwd} />
    </div>}
  </div>;
}

/** Chronological narration and tool lines. Live turns show the running
 *  tool's pulsing dot. The list stays flat: a caption above a run of reads
 *  repeated what the status row already says, indented the steps under a
 *  heading nobody needed, and cost a type-scale step of its own. */
function ActivityTrace({ groups, cwd, live = false }: { groups: ActivityGroup[]; cwd?: string; live?: boolean }) {
  return <>
    {groups.map((group) => <ActivityGroupSection key={`${group.kind}:${group.id}`} group={group} cwd={cwd} live={live} />)}
  </>;
}

function ActivityGroupSection({ group, cwd, live }: { group: ActivityGroup; cwd?: string; live: boolean }) {
  const grouped = group.kind !== "single" && group.blocks.length >= 2;
  const attention = group.blocks.some((block) => block.kind === "tool" && (block.status === "running" || block.status === "error"));
  const [expanded, setExpanded] = useState(live || attention);
  const contentId = useId();
  const entries = (grouped && !expanded ? [] : group.blocks).map((block) => block.kind === "agent"
    ? <div key={block.id} id={`thread-block-${block.id}`} className={cn(styles.entry, styles.narration, "min-w-0")}><MarkdownViewer variant="chat" mode={block.partial ? "streaming" : "final"} className="text-ui-body leading-relaxed text-muted [overflow-wrap:anywhere]" resourceContext={cwd ? { cwd } : undefined}>{parseSuggestions(block.parts.map((part) => part.text).join("")).clean}</MarkdownViewer></div>
    : block.kind === "thinking"
      ? <ThinkingRow key={block.id} block={block} />
      : <TraceItem key={block.id} block={block} live={live} cwd={cwd} />);
  if (!grouped) return entries;
  return <div data-activity-group-id={group.id} data-activity-group-kind={group.kind} data-thread-block-ids={group.blocks.map((block) => block.id).join(" ")} className={cn(styles.entry, "min-w-0")}>
    <GroupSummary group={group} live={live} expanded={expanded} controlsId={contentId} onToggle={() => setExpanded((value) => !value)} />
    {expanded && <div id={contentId} className="ml-1.5 border-l border-border/70 pl-3">{entries}</div>}
  </div>;
}

/** One reasoning phase. Same single-line row as the tool steps — running dot,
 *  phase label, and the newest reasoning fragment at the right edge — so the
 *  phase reads as one more step instead of a separate wall of prose. The full
 *  reasoning folds behind the row, exactly like a step's input/output. */
function ThinkingRow({ block }: { block: ThinkingBlock }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const text = block.parts.map((part) => part.text).join("");
  const running = block.partial === true;
  const duration = running ? null : stepDuration(block);
  // Mirror the running tool's live tail: while the model reasons, the freshest
  // fragment streams at the right edge of the row.
  const liveTail = running ? lastStreamLine(text) : null;
  return <div id={`thread-block-${block.id}`} data-running={running} className={cn(styles.entry, styles.thinking, "min-w-0")}>
    <button type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)} className={cn(styles.toolButton, "flex min-h-primary max-w-full items-center gap-2 rounded-input py-2 text-left text-ui-label text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-control")}>
      {running ? <span aria-hidden className="mx-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : <span data-activity-kind="reasoning" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted"><Brain size={14} aria-hidden /></span>}
      <span className="min-w-0 truncate">{t(running ? "conversation.activity.thinking" : "conversation.activity.reasoning")}</span>
      {liveTail && <span aria-hidden className="hidden min-w-0 flex-1 truncate text-right font-mono text-ui-micro text-muted sm:block">{liveTail}</span>}
      {duration && <span aria-hidden="true" className="shrink-0 font-mono text-ui-micro tabular-nums text-muted">{duration}</span>}
      {running && <LiveStepElapsed since={block.startedAt} />}
      <ChevronRight size={12} aria-hidden className={cn(styles.chevron, "shrink-0 transition-transform", expanded && "rotate-90")} />
    </button>
    {expanded && <div id={panelId} className={cn(styles.details, "pb-2")}>
      <div className="whitespace-pre-wrap text-ui-caption italic leading-snug text-muted [overflow-wrap:anywhere]">{text}</div>
    </div>}
  </div>;
}

/** Self-ticking clock for one running phase. It measures the phase, not the
 *  turn, so a reasoning row reports the same quantity while it runs as the
 *  finished row reports when it ends. Lives in its own component so the tick
 *  never re-renders the surrounding trace. */
function LiveStepElapsed({ since }: { since?: string }) {
  const [, tick] = useState(0);
  const startedAt = useMemo(() => {
    if (!since) return null;
    const parsed = Date.parse(since);
    return Number.isFinite(parsed) ? parsed : null;
  }, [since]);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (startedAt === null) return null;
  return <span aria-hidden="true" className="shrink-0 font-mono text-ui-micro tabular-nums text-muted">{formatSeconds(Math.max(0, (Date.now() - startedAt) / 1000))}</span>;
}

function GroupSummary({ group, live, expanded, controlsId, onToggle }: { group: ActivityGroup; live: boolean; expanded: boolean; controlsId: string; onToggle: () => void }) {
  const { t } = useTranslation();
  const done = group.blocks.filter((block) => block.kind === "tool" && block.status !== "running").length;
  const failed = group.blocks.filter((block) => block.kind === "tool" && block.status === "error").length;
  const prefix = group.kind === "changes" ? "changes" : group.kind === "execution" ? "execution" : "explore";
  const label = live
    ? t(`conversation.activity.${prefix}SummaryLive`, { done, count: group.blocks.length })
    : t(`conversation.activity.${prefix}Summary`, { count: group.blocks.length });
  const Icon = group.kind === "changes" ? FilePenLine : group.kind === "execution" ? Terminal : Search;
  return <button type="button" aria-expanded={expanded} aria-controls={controlsId} onClick={onToggle} className="group flex min-h-8 w-full items-center gap-2 rounded-input px-1 text-left text-ui-caption text-muted hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
    <Icon size={13} aria-hidden className="shrink-0" />
    <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
    {failed > 0 && <span className="shrink-0 text-[10px] font-medium text-error-text">{t("conversation.activity.groupFailed", { count: failed })}</span>}
    <ChevronRight size={12} aria-hidden className={cn(styles.chevron, "shrink-0", expanded && "rotate-90")} />
  </button>;
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
  const displayedForced = displayed?.forced === true;
  const shownAt = useRef(Date.now());
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (!live || !targetKey) {
      setDisplayed(null);
      return;
    }
    if (displayedKey === targetKey) return;
    if (!displayedKey || targetForced || displayedForced) {
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
  }, [displayedForced, displayedKey, live, targetForced, targetKey]);
  return live ? target?.mergeKey === displayed?.mergeKey ? target : displayed : null;
}

function ActivityLabel({ title, detail, error = false, elapsed }: { title: string; detail: string | null; error?: boolean; elapsed?: ReactNode }) {
  return <span aria-live="polite" aria-atomic="true" className={styles.label}>
    <span className={cn(styles.title, "text-text", error && "text-error-text")}>{title}</span>
    {detail && <span className={cn(styles.detail, "text-muted")}>{detail}</span>}
    {elapsed}
  </span>;
}

/** Self-ticking turn clock. Lives in its own component so the 4 Hz tick
 *  re-renders only this chip, never the activity row's narration tree. */
function LiveElapsed({ live, turnStartedAt }: { live: boolean; turnStartedAt?: string }) {
  const [, tick] = useState(0);
  const mountStartedAt = useRef<number | null>(null);
  const restoredStartedAt = useMemo(() => {
    if (!turnStartedAt) return null;
    const parsed = Date.parse(turnStartedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }, [turnStartedAt]);
  if (live && mountStartedAt.current === null) mountStartedAt.current = Date.now();
  if (!live) mountStartedAt.current = null;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [live]);
  const startedAt = restoredStartedAt ?? mountStartedAt.current;
  if (!live || startedAt === null) return null;
  return <span aria-hidden="true" className="shrink-0 font-mono text-ui-micro tabular-nums text-muted">{formatSeconds(Math.max(0, (Date.now() - startedAt) / 1000))}</span>;
}

function formatSeconds(totalSeconds: number): string {
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
  if (totalSeconds < 60) return `${Math.floor(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${String(Math.floor(totalSeconds % 60)).padStart(2, "0")}s`;
}

function stepDuration(block: { startedAt?: string; endedAt?: string }): string | null {
  if (!block.startedAt || !block.endedAt) return null;
  const start = Date.parse(block.startedAt);
  const end = Date.parse(block.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return formatSeconds(Math.max(0, (end - start) / 1000));
}

function formatProcessDuration(blocks: ActivityBlock[], turnStartedAt?: string, turnEndedAt?: string): string | null {
  const validTime = (value?: string) => value ? Date.parse(value) : Number.NaN;
  const starts = [validTime(turnStartedAt), ...blocks.map((block) => validTime(block.kind === "tool" ? block.startedAt : block.kind === "thinking" ? block.startedAt ?? block.timestamp : block.timestamp))].filter(Number.isFinite);
  const ends = [validTime(turnEndedAt), ...blocks.map((block) => validTime(block.kind === "tool" || block.kind === "thinking" ? block.endedAt : undefined))].filter(Number.isFinite);
  if (starts.length === 0 || ends.length === 0) return null;
  return formatPositiveDuration(Math.max(...ends) - Math.min(...starts));
}

function formatTimestampDuration(startTimestamp?: string, endTimestamp?: string): string | null {
  if (!startTimestamp || !endTimestamp) return null;
  const start = Date.parse(startTimestamp);
  const end = Date.parse(endTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return formatPositiveDuration(end - start);
}

/** A span only means something when it is positive. Zero, negative, and
 *  unparseable intervals are dropped rather than reported as `0.0s`, and a
 *  sub-100 ms span would round to that same misleading value. */
function formatPositiveDuration(elapsedMs: number): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  if (elapsedMs < 100) return "<0.1s";
  return formatSeconds(elapsedMs / 1000);
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

function TraceItem({ block, live, cwd }: { block: ToolCallBlock; live: boolean; cwd?: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);
  const openInspector = useUiStore((state) => state.openInspector);
  const activity = projectToolActivity(block);
  const renderer = activityRendererRegistry.resolve(activity.presentation?.renderer ?? activity.kind);
  const rendererProps = { activity, source: block, live, t };
  const compact = renderer.compact(rendererProps);
  const errorSummary = toolErrorSummary(block);
  const rawFilePath = toolFilePath(block);
  const filePath = cwd && rawFilePath ? toWorkspaceRelativePath(rawFilePath, cwd) : null;
  const failedAttempts = block.statusHistory?.filter((status) => status === "error").length ?? 0;
  const recovered = block.status === "done" && failedAttempts > 0;
  const attempts = attemptSummaries(block.statusHistory ?? [block.status]);
  const hasStructuredDetails = block.details !== undefined && block.details !== null;
  const hasDetails = Boolean(block.input || block.output || block.partialOutput || block.diff || hasStructuredDetails || errorSummary || attempts.length > 1 || filePath);
  const details = expanded ? renderer.expanded(rendererProps) : null;
  const running = live && block.status === "running";
  const duration = running ? null : stepDuration(block);
  const progressDisplay = selectToolProgressDisplay(block.status, block.progress);
  // The layer is the row's own measurement, and it outlives the step; while it
  // is on screen the right edge would repeat it, so the tail yields to it.
  const showsProgress = useProgressLayerVisible(block, running) && progressLayerRenders(progressDisplay);
  // While the operation streams, its freshest output line fills the right
  // edge of the row and the chevron sits at the far right; once the step
  // completes the tail makes way for the duration chip.
  const streamingTail = running && block.partialOutput ? lastStreamLine(block.partialOutput) : null;
  const liveTail = streamingTail ?? compact.detail ?? null;
  const secondary = showsProgress ? null : liveTail;
  return <div id={`thread-block-${block.id}`} className={cn(styles.entry, styles.tool, "scroll-mt-4")} data-running={running}>
    <button type="button" disabled={!hasDetails} aria-expanded={hasDetails ? expanded : undefined} onClick={() => hasDetails && setExpanded((value) => !value)} className={cn(styles.toolButton, "flex min-h-primary max-w-full items-center gap-2 rounded-input py-2 text-left text-ui-label text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default sm:min-h-control")}>
      {running ? <span aria-hidden className="mx-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : block.status === "error" ? <CircleX size={14} aria-hidden className="shrink-0 text-error-text" /> : <ActivityCategoryIcon block={block} className="text-muted" />}
      <span className="min-w-0 flex-1"><span className="block max-w-[52ch] truncate" title={compact.title}>{compact.title}</span></span>
      {secondary && <span className={cn("min-w-0 truncate text-right text-muted", streamingTail ? "hidden flex-1 font-mono text-ui-micro sm:block" : "max-w-[40%] text-xs font-normal")}>{secondary}</span>}
      {recovered && <span className="shrink-0 rounded-full bg-warn-fill px-1.5 py-0.5 text-[10px] font-medium text-white">{t("conversation.activity.recoveredAfterRetry")}</span>}
      {compact.fileChange ? <span
        aria-label={t("conversation.activity.lineChanges", { additions: compact.fileChange.additions, deletions: compact.fileChange.deletions })}
        className={cn("inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold leading-none tabular-nums", !liveTail && !recovered && "ml-auto")}
      >
        {compact.fileChange.additions > 0 && <span className="text-ok-text">+{compact.fileChange.additions}</span>}
        {compact.fileChange.deletions > 0 && <span className="text-error-text">-{compact.fileChange.deletions}</span>}
        {compact.fileChange.truncated && <span className="text-muted" title={t("conversation.activity.diffTruncated")}>…</span>}
      </span> : null}
      {duration && <span aria-hidden="true" className="shrink-0 font-mono text-ui-micro tabular-nums text-muted">{duration}</span>}
      {hasDetails && <ChevronRight size={12} aria-hidden className={cn(styles.chevron, "shrink-0 transition-transform", expanded && "rotate-90")} />}
    </button>
    {showsProgress && <ToolProgressLayer display={progressDisplay} settled={!running} />}
    {expanded && hasDetails && details && <div className={cn(styles.details, "space-y-2 pb-2 pl-6 text-xs")}>
      {(filePath || errorSummary || recovered) && <div className="flex flex-wrap items-center gap-2">
        {filePath && cwd && <>
          <span className="basis-full break-all font-mono text-[11px] text-muted" title={filePath}>{filePath}</span>
          <button type="button" onClick={() => { void pinnedFileInspector(filePath, filePath.split("/").at(-1), "workspace", cwd).then(openInspector).catch(() => undefined); }} className="inline-flex min-h-7 items-center gap-1 rounded-input border border-border px-2 text-[11px] text-muted hover:bg-surface-hover hover:text-text"><ExternalLink size={12} />{t("conversation.activity.openFile")}</button>
          <button type="button" onClick={() => revealWorkspaceFile(cwd, filePath)} className="inline-flex min-h-7 items-center gap-1 rounded-input border border-border px-2 text-[11px] text-muted hover:bg-surface-hover hover:text-text"><FolderSearch size={12} />{t("conversation.activity.locateFile")}</button>
        </>}
        {errorSummary && <button type="button" onClick={() => { void navigator.clipboard.writeText(errorSummary).then(() => { setErrorCopied(true); window.setTimeout(() => setErrorCopied(false), 2_000); }).catch(() => setErrorCopied(false)); }} className="inline-flex min-h-7 items-center gap-1 rounded-input border border-border px-2 text-[11px] text-muted hover:bg-surface-hover hover:text-text"><Copy size={12} />{t(errorCopied ? "conversation.activity.errorCopied" : "conversation.activity.copyError")}</button>}
        {recovered && <span className="text-[11px] text-muted">{t("conversation.activity.retryHistory", { count: failedAttempts })}</span>}
      </div>}
      {attempts.length > 1 && <AttemptHistory attempts={attempts} />}
      {details.map((detail, index) => detail.pre || detail.plain
        ? <Detail key={`${detail.label}:${index}`} label={detail.label} value={detail.value} pre={detail.pre} />
        : <OutputDetail key={`${detail.label}:${index}`} label={detail.label} value={detail.value} fullValue={detail.fullValue} partial={detail.partial} diff={detail.diff} transportTruncated={detail.transportTruncated} originalBytes={detail.originalBytes} t={t} />)}
    </div>}
  </div>;
}

type AttemptSummary = { number: number; status: ToolCallBlock["status"] };

/** Legacy events expose transitions rather than structured attempts. Preserve
 * that information as a readable timeline now; a future protocol-level
 * attempt record can enrich the same surface with per-attempt output/timing. */
function attemptSummaries(history: ToolCallBlock["statusHistory"]): AttemptSummary[] {
  const attempts: AttemptSummary[] = [];
  let current: AttemptSummary | null = null;
  for (const status of history ?? []) {
    if (status === "running" || status === "waiting-approval" || status === "unknown") {
      if (!current || current.status === "done" || current.status === "error") {
        current = { number: attempts.length + 1, status };
        attempts.push(current);
      } else {
        current.status = status;
      }
      continue;
    }
    if (!current || current.status === "done" || current.status === "error") {
      current = { number: attempts.length + 1, status };
      attempts.push(current);
    } else {
      current.status = status;
    }
  }
  return attempts;
}

function AttemptHistory({ attempts }: { attempts: AttemptSummary[] }) {
  const { t } = useTranslation();
  return <div className="rounded-input border border-border/70 bg-surface-2/40 px-2.5 py-2">
    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{t("conversation.activity.attemptHistory")}</div>
    <ol className="space-y-1">
      {attempts.map((attempt) => {
        const failed = attempt.status === "error";
        const succeeded = attempt.status === "done";
        return <li key={attempt.number} className="flex items-center gap-2 text-[11px]">
          {failed ? <CircleX size={12} aria-hidden className="text-error-text" /> : succeeded ? <Check size={12} aria-hidden className="text-ok-text" /> : <span aria-hidden className="mx-0.5 h-2 w-2 rounded-full bg-accent" />}
          <span className="font-medium text-text">{t("conversation.activity.attemptNumber", { number: attempt.number })}</span>
          <span className={failed ? "text-error-text" : succeeded ? "text-ok-text" : "text-muted"}>{t(`conversation.activity.attemptStatus.${attempt.status}`)}</span>
        </li>;
      })}
    </ol>
  </div>;
}

/** The freshest meaningful line of a streaming text (tool output or live
 *  reasoning), whitespace collapsed and bounded so it fits the row's right
 *  edge. */
function lastStreamLine(value: string): string | null {
  const lines = value.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const tail = lines.at(-1);
  if (!tail) return null;
  return tail.length > 120 ? `…${tail.slice(-120)}` : tail;
}

const TOOL_PROGRESS_DELAY_MS = 500;

/** A layer only counts as present when it puts rows on screen: a phase without
 *  a label and without a number renders nothing, so it must not take the
 *  tail's place on the right edge. */
function progressLayerRenders(display: ReturnType<typeof selectToolProgressDisplay>): boolean {
  return display.mode !== "hidden" && !(display.mode === "indeterminate" && !display.label);
}

/** The row's measured progress appears under it half a second after the step
 *  starts, so a fast step never flashes a bar. The row owns the timer so the
 *  layer's arrival and the tail's departure are the same render. A settled row
 *  keeps the layer it already earned: the same delay decides, so a step too
 *  short to have shown a bar does not gain one at the end. When the transcript
 *  dropped the timing, a surviving measurement is the only evidence left. */
function useProgressLayerVisible(block: ToolCallBlock, running: boolean): boolean {
  const [mountedAt] = useState(() => Date.now());
  const [visible, setVisible] = useState(false);
  const startedAt = useMemo(() => {
    const parsed = block.startedAt ? Date.parse(block.startedAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : mountedAt;
  }, [block.startedAt, mountedAt]);
  const endedAt = useMemo(() => {
    const parsed = block.endedAt ? Date.parse(block.endedAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }, [block.endedAt]);
  useEffect(() => {
    if (!running) return;
    const elapsed = Math.max(0, Date.now() - startedAt);
    if (elapsed >= TOOL_PROGRESS_DELAY_MS) {
      setVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), TOOL_PROGRESS_DELAY_MS - elapsed);
    return () => window.clearTimeout(timer);
  }, [running, startedAt]);
  if (running) return visible;
  if (endedAt === null) return block.progress !== undefined;
  return endedAt - startedAt >= TOOL_PROGRESS_DELAY_MS;
}

/** Measured progress sits under the tool row; it renders only after the row's
 *  visibility timer says the step is long enough to deserve a bar. A settled
 *  row keeps that layer frozen at the producer's last value: the fill drops to
 *  the measurement ink, the track leaves the accessibility tree, and the text
 *  still carries the number, because the row's own marker carries the state. */
function ToolProgressLayer({ display, settled }: { display: ReturnType<typeof selectToolProgressDisplay>; settled: boolean }) {
  const { t, i18n } = useTranslation();
  const fillClass = cn(styles.progressFill, settled && styles.progressFillSettled);
  if (display.mode === "hidden") return null;
  if (display.mode === "indeterminate") return display.label
    ? <div className={styles.progressLayer} data-settled={settled ? "true" : undefined}>
      <span className={styles.progressLabel}>{display.label}</span>
    </div>
    : null;
  if (display.mode === "percent") {
    const percent = Math.min(100, Math.floor(display.value));
    return <div className={styles.progressLayer} data-settled={settled ? "true" : undefined}>
      <div className={styles.progressText}>
        <span className={styles.progressLabel}>{display.scopeLabel}</span>
        <span className={styles.progressPercent} aria-hidden="true">{percent}%</span>
      </div>
      <div role="progressbar" aria-hidden={settled ? "true" : undefined} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${display.scopeLabel} ${percent}%`} className={styles.progressTrack}>
        <div className={fillClass} style={{ width: `${percent}%` }} />
      </div>
    </div>;
  }
  // A byte count is formatted here rather than in the adapter, so the contract
  // keeps the producer's number and every renderer derives the same unit.
  const bytes = display.unit === "bytes";
  const unitSuffix = display.unit && !bytes ? ` ${display.unit}` : "";
  const size = (value: number) => (bytes ? formatBytes(value, i18n.language) : String(value));
  if (display.mode === "count") return <div className={styles.progressLayer} data-settled={settled ? "true" : undefined}>
    <span className={styles.progressLabel}>{t("conversation.activity.progressCount", { scope: display.scopeLabel, count: size(display.value), unitSuffix })}</span>
  </div>;
  const percent = Math.min(100, Math.floor(display.percent));
  // An estimate is a text property: the bar shows the share, and only the
  // sentence says the total may still move.
  const estimated = display.mode === "estimated";
  const label = t(estimated ? "conversation.activity.progressEstimated" : "conversation.activity.progressDeterminate", { scope: display.scopeLabel, current: size(display.current), total: size(display.total), unitSuffix });
  return <div className={styles.progressLayer} data-settled={settled ? "true" : undefined}>
    <div className={styles.progressText}>
      <span className={styles.progressLabel}>{label}</span>
      {!estimated && <span className={styles.progressPercent} aria-hidden="true">{percent}%</span>}
    </div>
    <div role="progressbar" aria-hidden={settled ? "true" : undefined} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={estimated ? label : undefined} aria-label={estimated ? display.scopeLabel : `${display.scopeLabel} ${percent}%`} className={styles.progressTrack}>
      <div className={fillClass} style={{ width: `${percent}%` }} />
    </div>
  </div>;
}

const DETAIL_PREVIEW_LIMIT = 8_000;

function OutputDetail({
  label,
  value,
  fullValue,
  partial = false,
  diff = false,
  transportTruncated = false,
  originalBytes,
  t,
}: {
  label: string;
  value: string;
  fullValue?: string;
  partial?: boolean;
  diff?: boolean;
  transportTruncated?: boolean;
  originalBytes?: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [showFull, setShowFull] = useState(false);
  const truncated = value.length > DETAIL_PREVIEW_LIMIT;
  const canShowFull = !transportTruncated && Boolean(fullValue && fullValue.length > DETAIL_PREVIEW_LIMIT);
  const rendered = showFull && canShowFull ? fullValue! : value.slice(0, DETAIL_PREVIEW_LIMIT);
  return <div>
    <div className="mb-1 text-ui-micro font-medium uppercase tracking-wider text-muted">{label}</div>
    {diff
      ? <DiffView diff={rendered} className="max-h-48 overflow-auto break-all rounded-input bg-surface px-2 py-1.5 leading-5" />
      : <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-input bg-surface px-2 py-1.5 font-mono text-xs leading-5 text-text">{rendered}</pre>}
    {(truncated || transportTruncated) && <div className="mt-1 flex flex-wrap items-center gap-2 text-ui-micro text-muted">
      {transportTruncated && <span>{t("conversation.activity.transportTruncated", { bytes: formatOriginalBytes(originalBytes) })}</span>}
      {truncated && <span>{t("conversation.activity.previewTruncated", { count: DETAIL_PREVIEW_LIMIT })}</span>}
      {canShowFull
        ? <button type="button" onClick={() => setShowFull((current) => !current)} className="underline underline-offset-2 hover:text-text">{t("conversation.activity.fullOutput")}{showFull ? " ↑" : " ↓"}</button>
        : <span>{t("conversation.activity.fullOutputUnavailable")}</span>}
    </div>}
    {partial && !transportTruncated && !truncated && <div className="mt-1 text-ui-micro text-muted">{t("conversation.activity.fullOutputUnavailable")}</div>}
  </div>;
}
function Detail({ label, value, pre = false }: { label: string; value: string; pre?: boolean }) { return <div><div className="mb-1 text-ui-micro font-medium uppercase tracking-wider text-muted">{label}</div>{pre ? <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-input bg-surface px-2 py-1.5 font-mono text-xs leading-5 text-text">{value}</pre> : <div className="break-all font-mono text-xs text-text">{value}</div>}</div>; }

function formatOriginalBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
