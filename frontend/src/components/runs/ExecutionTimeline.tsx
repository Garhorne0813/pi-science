import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Maximize2, Minus, Plus } from "lucide-react";
import type { ExecutionLedgerProps } from "./ExecutionLedger";
import { executionTimeline, timelineTicks } from "./timeline";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon";
import { formatDuration, executionLabel, executionShortLabel, executionError, formatTimestamp, isActiveExecution, isProblemExecution } from "./run-formatters";
import { cn } from "../../lib/ui";

export function ExecutionTimeline({ runs, selectedId, onSelect, groupBySession, sessionTitles = {} }: ExecutionLedgerProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const active = runs.some(isActiveExecution);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  const timeline = executionTimeline(runs, now);
  const known = timeline.rows.some((row) => row.known);
  const ticks = known ? timelineTicks(timeline.start, timeline.end, zoom) : [];
  const groups = groupBySession ? [...new Set(timeline.rows.map((row) => row.run.correlation.session_id || ""))].map((id) => ({
    id, rows: timeline.rows.filter((row) => (row.run.correlation.session_id || "") === id),
  })) : [{ id: "", rows: timeline.rows }];
  const tickFormat = new Intl.DateTimeFormat(undefined, timeline.end - timeline.start >= 86_400_000
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit", ...(timeline.end - timeline.start < 120_000 ? { second: "2-digit" } : {}), ...(timeline.end - timeline.start < 1_000 ? { fractionalSecondDigits: 3 } : {}) });
  const fit = () => { setZoom(1); if (scrollRef.current) scrollRef.current.scrollLeft = 0; };
  const guides = <span aria-hidden="true" className="pointer-events-none absolute inset-0">{ticks.map((tick) => <span key={tick.time} style={{ left: `${tick.left}%` }} className={cn("absolute inset-y-0 border-l", tick.major ? "border-border" : "border-faint")} />)}</span>;

  return <section aria-label={t("runs.timeline")} className="runs-ledger-pane min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <h2 className="text-sm font-semibold text-text">{t("runs.timeline")}</h2>
      <div className="flex items-center gap-1" aria-label={t("runs.timelineControls")}>
        <button type="button" onClick={fit} className="flex min-h-8 items-center gap-1.5 rounded-input px-2 text-xs text-muted hover:bg-surface-2"><Maximize2 size={13} />{t("runs.fit")}</button>
        <button type="button" aria-label={t("runs.zoomOut")} title={t("runs.zoomOut")} disabled={zoom === 1} onClick={() => setZoom((value) => Math.max(1, value / 2))} className="min-h-8 rounded-input p-2 text-muted hover:bg-surface-2 disabled:opacity-40"><Minus size={14} /></button>
        <span className="min-w-9 text-center text-xs tabular-nums text-muted">{zoom}×</span>
        <button type="button" aria-label={t("runs.zoomIn")} title={t("runs.zoomIn")} disabled={zoom === 8} onClick={() => setZoom((value) => Math.min(8, value * 2))} className="min-h-8 rounded-input p-2 text-muted hover:bg-surface-2 disabled:opacity-40"><Plus size={14} /></button>
      </div>
    </div>
    <p className="px-4 pt-3 text-xs leading-5 text-muted">{t("runs.timelineHint")}</p>
    <p className="px-4 pb-3 text-xs text-muted">{known ? `${formatTimestamp(new Date(timeline.start).toISOString())} — ${formatTimestamp(new Date(timeline.end).toISOString())}` : t("runs.unknownTiming")}</p>
    <div ref={scrollRef} tabIndex={0} aria-label={t("runs.timelineScroll")} className="min-h-0 flex-1 overflow-auto">
      <div data-testid="timeline-canvas" style={{ width: `${zoom * 100}%` }} className="min-w-[560px] pb-3">
        <div className="runs-timeline-grid sticky top-0 z-20 grid border-y border-border bg-surface">
          <span className="sticky left-0 z-10 bg-surface px-4 py-3 text-xs font-medium text-muted">{t("runs.execution")}</span>
          <span className="relative mr-4 block h-11">{guides}{ticks.filter((tick) => tick.major).map((tick) => <time key={tick.time} dateTime={new Date(tick.time).toISOString()} style={{ left: `${tick.left}%`, transform: tick.left > 90 ? "translateX(-100%)" : tick.left < 10 ? undefined : "translateX(-50%)" }} className="absolute top-2 whitespace-nowrap text-[11px] tabular-nums text-muted">{tickFormat.format(tick.time)}</time>)}</span>
        </div>
        {groups.map((group) => <div key={group.id}>
          {groupBySession && <button type="button" aria-expanded={!collapsed.has(group.id)} onClick={() => setCollapsed((current) => { const next = new Set(current); if (!next.delete(group.id)) next.add(group.id); return next; })} className="sticky left-0 flex min-h-10 w-full items-center gap-2 border-b border-border bg-surface-2 px-4 text-left text-xs font-medium text-text"><ChevronDown size={13} className={collapsed.has(group.id) ? "-rotate-90" : ""} /><span className="max-w-[260px] truncate" title={group.id}>{sessionTitles[group.id] || group.id || t("runs.unassociated")}</span><span className="text-muted">{group.rows.length}</span></button>}
          {(!groupBySession || !collapsed.has(group.id)) && group.rows.map(({ run, left, width, known, start, end, active: running }) => {
            const problem = isProblemExecution(run);
            const duration = known ? formatDuration(end - start) : "—";
            const summary = executionError(run) || run.result.output_preview || run.result.stdout_preview;
            return <button key={run.execution_id} type="button" aria-label={`${executionShortLabel(run)} · ${executionLabel(run)} · ${t(`runs.status.${run.status}`)} · ${duration}${known ? "" : ` · ${t("runs.unknownTiming")}`}`} aria-current={selectedId === run.execution_id ? "true" : undefined} onClick={() => onSelect(run.execution_id)} title={`${executionLabel(run)}\n${t(`runs.status.${run.status}`)} · ${duration}\n${formatTimestamp(run.started_at)} — ${formatTimestamp(run.ended_at)}${summary ? `\n${summary}` : ""}`} className={cn("runs-timeline-grid grid min-h-20 w-full border-b border-faint text-left focus-visible:relative focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent", selectedId === run.execution_id ? "bg-accent-soft" : "bg-surface hover:bg-surface-2/60")}>
              <span className={cn("sticky left-0 z-10 min-w-0 px-4 py-3", selectedId === run.execution_id ? "bg-accent-soft" : "bg-surface")}>
                <span className="flex items-start gap-2"><ExecutionStatusIcon status={run.status} size={14} /><span className="line-clamp-2 break-all text-[13px] font-medium leading-5 text-text">{executionShortLabel(run)}</span></span>
                <span className={cn("mt-1 block pl-[22px] text-xs", problem ? "text-error-text" : "text-muted")}>{t(`runs.status.${run.status}`)} · {duration}</span>
              </span>
              <span className="relative mr-4 flex min-w-0 items-center">
                {guides}
                {known ? <span data-testid={`timeline-${run.execution_id}`} style={{ left: left > 99.5 ? "calc(100% - 8px)" : `${left}%`, width: `${width}%`, minWidth: 8, maxWidth: left > 99.5 ? 8 : `${100 - left}%` }} className={cn("absolute h-6 rounded border", problem ? "border-error bg-error/70" : running ? "animate-pulse border-accent bg-accent/60" : "border-ok/50 bg-ok/55")} /> : <span className="relative px-2 text-xs text-muted">{t("runs.unknownTiming")}</span>}
              </span>
            </button>;
          })}
        </div>)}
      </div>
    </div>
  </section>;
}
