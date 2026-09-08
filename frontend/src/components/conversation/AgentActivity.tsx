import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { ChevronRight, Check, CircleX, Square } from "lucide-react";
import type { ProgressAppearance } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import type { AgentMessageBlock, ThreadBlock, ToolCallBlock } from "../../types/thread";
import { activityPolicy, executionOperationCount } from "../../lib/conversation/activity-policy";
import { useRuntimeStore } from "../../lib/agent-runtime";
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

type DisclosureChoice = "auto" | "user-open" | "user-closed";

const disclosureChoices = new Map<string, DisclosureChoice>();
const disclosureSubscribers = new Map<string, Set<() => void>>();

function readDisclosure(key?: string): DisclosureChoice {
  if (!key) return "auto";
  const shared = disclosureChoices.get(key);
  if (shared) return shared;
  try {
    const value = localStorage.getItem(key);
    if (value === "user-open" || value === "user-closed") {
      disclosureChoices.set(key, value);
      return value;
    }
  } catch {
    return "auto";
  }
  return "auto";
}

function writeDisclosure(key: string | undefined, choice: DisclosureChoice): void {
  if (!key) return;
  disclosureChoices.set(key, choice);
  try { localStorage.setItem(key, choice); } catch { /* storage is optional */ }
  disclosureSubscribers.get(key)?.forEach((listener) => listener());
}

export function resetDisclosuresForTests(): void {
  disclosureChoices.clear();
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith("conversation-disclosure:")) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch { /* storage is optional */ }
}

function subscribeDisclosure(key: string | undefined, listener: () => void): () => void {
  if (!key) return () => undefined;
  let subscribers = disclosureSubscribers.get(key);
  if (!subscribers) {
    subscribers = new Set();
    disclosureSubscribers.set(key, subscribers);
  }
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

/** The content and status parts are separate component instances, so the
 *  live-feed disclosure lives in a shared external store: toggling Hide in
 *  the status row collapses the content instance immediately. */
function useDisclosure(key: string | undefined, live: boolean): { expanded: boolean; toggle: () => void } {
  // Keyed instances share the external store; a missing key falls back to
  // local state (standalone renders without a turn identity).
  const [localChoice, setLocalChoice] = useState<DisclosureChoice>("auto");
  const sharedChoice = useSyncExternalStore(
    (listener) => subscribeDisclosure(key, listener),
    () => readDisclosure(key),
    () => "auto" as DisclosureChoice,
  );
  const choice = key ? sharedChoice : localChoice;
  const choose = (next: DisclosureChoice) => {
    if (key) writeDisclosure(key, next);
    else setLocalChoice(next);
  };
  // A new live phase starts a fresh automatic disclosure.
  const previousLive = useRef(live);
  useEffect(() => {
    if (live && !previousLive.current && choice !== "auto") choose("auto");
    previousLive.current = live;
  }, [live]);
  const expanded = choice === "user-open" || (live && choice !== "user-closed");
  return { expanded, toggle: () => choose(expanded ? "user-closed" : "user-open") };
}

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
 *  aggregate progress row. The default renders both in order. Settled,
 *  aborted and failed turns render as one piece. */
export function AgentActivity({ blocks, contextBlocks = blocks, lifecycle = "active", cwd, disclosureKey, part = "both" }: { blocks: ActivityBlock[]; contextBlocks?: ThreadBlock[]; lifecycle?: TurnLifecycle; cwd?: string; disclosureKey?: string; part?: "both" | "content" | "status" }) {
  const { t } = useTranslation();
  const progressAppearance = useProgressAppearance();
  const abort = useRuntimeStore((state) => state.abort);
  const traceId = useId();
  const live = isLiveLifecycle(lifecycle);
  // Disclosure is shared view state (see useDisclosure): auto-open while
  // live, user choice sticky across completion, and both component instances
  // observe the same store.
  const { expanded, toggle: toggleDisclosure } = useDisclosure(disclosureKey, live);
  // Turn elapsed clock: starts when the live row appears, resets when the
  // turn settles. Visual-only (aria-hidden) so the aria-live label never
  // announces a ticking number.
  const liveSinceRef = useRef<number | null>(null);
  if (live && liveSinceRef.current === null) liveSinceRef.current = Date.now();
  if (!live) liveSinceRef.current = null;
  const tools = useMemo(() => blocks.filter((block): block is ToolCallBlock => block.kind === "tool"), [blocks]);
  const activities = useMemo(() => blocks.filter((block) => block.kind === "agent"
    ? Boolean(parseSuggestions(block.parts.map((part) => part.text).join("")).clean.trim())
    : activityPolicy(block).visibleInExecutionTrace), [blocks]);
  const activityGroups = useMemo(() => groupActivityBlocks(blocks), [blocks]);
  const traceTools = useMemo(() => activities.filter((block): block is ToolCallBlock => block.kind === "tool"), [activities]);
  const shown = useDisplayedActivity(tools, lifecycle);
  const task = useMemo(() => selectActivityTask(contextBlocks), [contextBlocks]);

  if (live) {
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
    const detail = lifecycle === "recovering"
      ? t("conversation.activity.recoveringDetail")
      : lifecycle === "stopping"
        ? t("conversation.activity.stoppingDetail")
      : lifecycle === "waiting"
        ? t("conversation.activity.task.interaction")
        // The mechanical label only fills the truly-empty case: a running tool
        // with no description and no phase narration. A curated phase text
        // always wins over "Running bash".
        : task.text ?? (task.fallback === "orient" && task.currentTool
          ? presentToolActivity(task.currentTool, t)
          : t(`conversation.activity.task.${task.fallback}`));
    const visualSlot = shown ? "currentActivity" : "thinking";
    // The stream already shows each tool's own line: the status detail is
    // redundant exactly when it repeats one of those labels (the mechanical
    // "Running bash" case). Curated task text stays — it is complementary.
    const duplicated = detail !== null && activities.some((block) => block.kind === "tool" && presentToolActivity(block, t) === detail);
    const showDetail = expanded && duplicated ? null : detail;
    const content = activities.length === 0 ? null : (
      <div id={blocks.length === 1 && blocks[0].kind === "tool" ? `thread-block-${blocks[0].id}` : undefined} data-thread-block-ids={blocks.map((block) => block.id).join(" ")} data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0 scroll-mt-4")}>
        {expanded && <div id={traceId} role="region" className={styles.trace} aria-label={t("conversation.activity.trace")}>
          <ActivityTrace groups={activityGroups} taskSourceId={task.sourceId} cwd={cwd} live />
        </div>}
      </div>
    );
    const status = (
      <div data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0")}>
        <div className="flex min-h-primary w-full items-center gap-2 py-1 text-left">
          <span key={state} className={styles.glyph}><ActivityIcon state={state} slot={visualSlot} config={progressAppearance} label={title} activityState={activityStateFor(lifecycle, shown)} /></span>
          <ActivityLabel title={title} detail={showDetail} error={false} />
          <LiveElapsed startedAt={liveSinceRef.current} live />
          {activities.length > 0 && <button type="button" aria-expanded={expanded} aria-label={t(expanded ? "conversation.activity.collapse" : "conversation.activity.expand")} onClick={toggleDisclosure} className="flex shrink-0 items-center gap-1 rounded-input px-1.5 py-0.5 text-ui-micro text-muted transition-colors hover:bg-surface-hover hover:text-text"><ChevronRight size={11} aria-hidden className={cn(styles.chevron, expanded && "rotate-90")} />{t(expanded ? "conversation.activity.collapse" : "conversation.activity.expand")}</button>}
          {(lifecycle === "active" || lifecycle === "queued" || lifecycle === "waiting") && <button type="button" onClick={() => void abort().catch(() => undefined)} className="flex shrink-0 items-center gap-1 rounded-input px-1.5 py-0.5 text-ui-micro text-muted transition-colors hover:bg-surface-hover hover:text-text"><Square size={9} aria-hidden className="fill-current" />{t("conversation.activity.stop")}</button>}
        </div>
      </div>
    );
    if (part === "content") return content;
    if (part === "status") return status;
    return <>{content}{status}</>;
  }

  if (activities.length === 0) return null;

  const canExpand = activities.length > 0;
  const hasExplicitFinal = blocks.some((block) => block.kind === "agent" && block.presentationRole === "final");
  const noAnswer = lifecycle === "settled"
    && !hasExplicitFinal
    && blocks.some((block) => block.kind === "agent" && block.presentationRole === "intermediate");
  // A settled turn with visible steps presents the steps themselves as the
  // row (one line each) — no separate "Complete" header, no count. Aborted
  // and failed turns keep their state headline instead.
  const settledSteps = lifecycle === "settled" && !noAnswer && canExpand && traceTools.length > 0;
  const state = lifecycle === "failed" || shown?.state === "error" ? "error" : lifecycle === "aborted" ? "stopped" : "completed";
  const title = lifecycle === "failed"
    ? t("conversation.activity.error")
    : lifecycle === "aborted"
      ? t("conversation.activity.stopped")
      : noAnswer
        ? t("conversation.activity.noAnswer")
      : t("conversation.activity.completed");

  const failureCount = traceTools.filter((block) => block.status === "error" || block.statusHistory?.includes("error")).length;
  // Deduped header metadata: a single step already shows its own duration on
  // the line, and the count repeats what the visible rows say. Only facts the
  // step lines cannot show survive into the header.
  const multiStep = traceTools.length > 1;
  const headerSegments = [
    multiStep ? t("conversation.activity.operationCount", { count: executionOperationCount(traceTools) }) : null,
    multiStep ? formatProcessDuration(traceTools) : null,
  ].filter(Boolean);
  // failureSummary carries its own separator.
  const failureSuffix = failureCount > 0 ? t("conversation.activity.failureSummary", { count: failureCount }) : "";
  const summary = t("conversation.activity.processHeader")
    + (headerSegments.length ? ` · ${headerSegments.join(" · ")}` : "")
    + failureSuffix;

  return <div id={blocks.length === 1 && blocks[0].kind === "tool" ? `thread-block-${blocks[0].id}` : undefined} data-thread-block-ids={blocks.map((block) => block.id).join(" ")} data-state={state} data-motion={progressAppearance.motion} style={activityStyle(progressAppearance)} className={cn(styles.root, "min-w-0 scroll-mt-4")}>
    {settledSteps ? (
      <button type="button" aria-expanded={expanded} aria-controls={traceId} onClick={toggleDisclosure} className={cn(styles.summary, "flex min-h-primary w-full items-center gap-2 rounded-input py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-control")}>
        <span className={cn(styles.steps, "min-w-0 flex-1")}>
          <span className="truncate text-ui-caption text-muted">{summary}</span>
          <span className="mt-0.5 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5">
            {traceTools.slice(-VISIBLE_STEP_COUNT).map((block) => <StepLine key={block.id} block={block} />)}
          </span>
        </span>
        <span className="sr-only" aria-live="polite">{t("conversation.activity.completed")}</span>
        <ChevronRight size={13} aria-hidden className={cn(styles.chevron, "shrink-0 text-muted", expanded && "rotate-90")} />
      </button>
    ) : (
      <button type="button" disabled={!canExpand} aria-expanded={canExpand ? expanded : undefined} aria-controls={canExpand && expanded ? traceId : undefined} onClick={toggleDisclosure} className={cn(styles.summary, "flex min-h-primary w-full items-center gap-2 rounded-input py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default sm:min-h-control")}>
        <span key={state} className={styles.glyph}><ActivityIcon state={state} slot="thinking" config={progressAppearance} label={title} activityState={activityStateFor(lifecycle, shown)} /></span>
        <ActivityLabel title={title} detail={null} error={state === "error"} />
        {canExpand && <ChevronRight size={13} aria-hidden className={cn(styles.chevron, "shrink-0 text-muted", expanded && "rotate-90")} />}
      </button>
    )}
    {expanded && canExpand && <div id={traceId} role="region" className={styles.trace} aria-label={t("conversation.activity.trace")}>
      <ActivityTrace groups={activityGroups} cwd={cwd} />
    </div>}
  </div>;
}

function ActivityTrace({ groups, taskSourceId, cwd, live = false }: { groups: ActivityGroup[]; taskSourceId?: string | null; cwd?: string; live?: boolean }) {
  const { t } = useTranslation();
  return <>
    {groups.map((group) => {
      const entries = group.blocks.map((block) => block.kind === "agent"
        ? (block.id !== taskSourceId && <div key={block.id} id={`thread-block-${block.id}`} className={cn(styles.entry, styles.narration, "min-w-0")}><MarkdownViewer variant="chat" className="text-ui-body leading-relaxed text-muted [overflow-wrap:anywhere]" resourceContext={cwd ? { cwd } : undefined}>{parseSuggestions(block.parts.map((part) => part.text).join("")).clean}</MarkdownViewer></div>)
        : <TraceItem key={block.id} block={block} live={live} />);
      if (group.kind !== "exploration" || group.blocks.length < 2) return entries;
      return <div key={group.id} data-activity-group-id={group.id} className={cn(styles.entry, "min-w-0")}>
        <div className="mb-0.5 text-ui-micro text-muted">{t("conversation.activity.exploreSummary", { count: group.blocks.length })}</div>
        {entries}
      </div>;
    })}
  </>;
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
function LiveElapsed({ startedAt, live }: { startedAt: number | null; live: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [live]);
  if (!live || startedAt === null) return null;
  return <span aria-hidden="true" className="shrink-0 font-mono text-ui-micro tabular-nums text-muted">{formatSeconds(Math.max(0, (Date.now() - startedAt) / 1000))}</span>;
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
  const output = block.output ?? block.partialOutput;
  const running = live && block.status === "running";
  const duration = running ? null : stepDuration(block);
  return <div className={cn(styles.entry, styles.tool)} data-running={running}>
    <button type="button" disabled={!hasDetails} aria-expanded={hasDetails ? expanded : undefined} onClick={() => hasDetails && setExpanded((value) => !value)} className={cn(styles.toolButton, "flex min-h-primary max-w-full items-center gap-2 rounded-input py-1.5 text-left text-ui-label text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default sm:min-h-control")}>
      {running ? <span aria-hidden className="mx-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : block.status === "running" ? <CircleX size={14} aria-hidden className="shrink-0 text-muted" /> : block.status === "error" ? <CircleX size={14} aria-hidden className="shrink-0 text-error-text" /> : block.status === "unknown" ? <CircleX size={14} aria-hidden className="shrink-0 text-warn" /> : <Check size={14} aria-hidden className="shrink-0 text-muted" />}
      <span className="min-w-0 flex-1 truncate">{presentToolActivity(block, t)}</span>
      {duration && <span aria-hidden="true" className="shrink-0 font-mono text-[10px] tabular-nums text-muted">{duration}</span>}
      {hasDetails && <ChevronRight size={12} aria-hidden className={cn(styles.chevron, "shrink-0", expanded && "rotate-90")} />}
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
const VISIBLE_STEP_COUNT = 4;

function StepLine({ block }: { block: ToolCallBlock }) {
  const { t } = useTranslation();
  const duration = stepDuration(block);
  return <span className={styles.step}>
    {block.status === "error"
      ? <CircleX size={11} aria-hidden className="shrink-0 text-error-text" />
      : <Check size={11} aria-hidden className="shrink-0 text-muted" />}
    <span className="min-w-0 truncate text-ui-caption text-muted">{presentToolActivity(block, t)}</span>
    {duration && <span aria-hidden="true" className="shrink-0 font-mono text-[10px] tabular-nums text-muted">{duration}</span>}
  </span>;
}

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
