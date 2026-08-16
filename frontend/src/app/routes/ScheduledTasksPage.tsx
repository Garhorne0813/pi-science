import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, Ban, Check, CircleDashed, Clock3, Loader2, Pause, Play, Plus, Pencil, Trash2, X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn, useUiStore } from "../../lib/ui";
import { fileInspectorForPath } from "../../lib/artifacts";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useFeedback } from "../../components/feedback/feedback-context";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";
import {
  approveScheduledTask, createScheduledTask, deleteScheduledTask, previewCron, runScheduledTask,
  scheduledTaskRunQuery, scheduledTaskRunsQuery, scheduledTasksQuery, updateScheduledTask,
  type ScheduledTask, type ScheduledTaskCreateInput, type ScheduledTaskPreview, type ScheduledTaskRun, type ScheduledTaskRunStatus,
} from "../../lib/scheduled-tasks";
import { humanReadableCron, isValidCron, nextCronRuns } from "../../lib/scheduled-tasks/cron";

type FormState = { mode: "create" } | { mode: "edit"; task: ScheduledTask } | null;

const PRESETS: Array<{ cron: string; key: "hourly" | "daily" | "weekdays" | "weekly" }> = [
  { cron: "0 * * * *", key: "hourly" },
  { cron: "0 9 * * *", key: "daily" },
  { cron: "0 9 * * 1-5", key: "weekdays" },
  { cron: "0 9 * * 1", key: "weekly" },
];

const TIMEZONES = [
  "UTC",
  "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Asia/Kolkata", "Australia/Sydney",
  "Europe/London", "Europe/Paris", "Europe/Berlin",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
];

function defaultTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export function ScheduledTasksPage() {
  const { t } = useTranslation();
  const { toast, confirm } = useFeedback();
  const cwd = useRequiredWorkspaceCwd();
  const openInspector = useUiStore((s) => s.openInspector);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [busyTask, setBusyTask] = useState<string | null>(null);

  const tasksResult = useQuery(scheduledTasksQuery(cwd));
  const tasks = tasksResult.data ?? [];
  const selected = tasks.find((task) => task.task_id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !tasks.some((task) => task.task_id === selectedId)) setSelectedId(null);
  }, [selectedId, tasks]);
  useEffect(() => {
    if (selectedRunId && selectedId !== selected?.task_id) setSelectedRunId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectedId, selectedRunId]);

  const tasksError = tasksResult.error;
  useEffect(() => {
    if (tasksError) toast(tasksError instanceof Error ? tasksError.message : t("scheduledTasks.loadError"), "error");
  }, [tasksError, t, toast]);

  const handleRunNow = async (task: ScheduledTask) => {
    if (busyTask) return;
    setBusyTask(task.task_id);
    try {
      const run = await runScheduledTask(cwd, task.task_id);
      if (run.status === "skipped") {
        toast(t("scheduledTasks.runSkipped", { reason: run.error ?? t("scheduledTasks.run.status.skipped") }), "error");
      } else if (run.status === "needs_attention") {
        toast(t("scheduledTasks.runNeedsAttention"), "info");
      } else {
        toast(t("scheduledTasks.runTriggered"), "success");
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : t("scheduledTasks.runError"), "error");
    } finally { setBusyTask(null); }
  };

  const handleToggle = async (task: ScheduledTask) => {
    if (busyTask) return;
    setBusyTask(task.task_id);
    try {
      await updateScheduledTask(cwd, task.task_id, { enabled: !task.enabled });
      toast(t(task.enabled ? "scheduledTasks.togglePaused" : "scheduledTasks.toggleResumed"), "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("scheduledTasks.toggleError"), "error");
    } finally { setBusyTask(null); }
  };

  const handleApprove = async (task: ScheduledTask) => {
    if (busyTask) return;
    setBusyTask(task.task_id);
    try {
      await approveScheduledTask(cwd, task.task_id, task.approval.categories);
      toast(t("scheduledTasks.approved"), "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("scheduledTasks.approveError"), "error");
    } finally { setBusyTask(null); }
  };

  const handleDelete = async (task: ScheduledTask) => {
    const approved = await confirm({
      title: t("scheduledTasks.deleteConfirmTitle"),
      message: t("scheduledTasks.deleteConfirmMessage", { name: task.name }),
      confirmLabel: t("common.delete"),
      destructive: true,
    });
    if (!approved) return;
    try {
      await deleteScheduledTask(cwd, task.task_id);
      toast(t("scheduledTasks.deleted"), "success");
      if (selectedId === task.task_id) setSelectedId(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : t("scheduledTasks.deleteError"), "error");
    }
  };

  const openFile = (path: string) => {
    const relative = workspaceRelativePath(path, cwd);
    if (!relative) {
      toast(t("scheduledTasks.fileOutsideWorkspace"), "error");
      return;
    }
    openInspector(fileInspectorForPath(relative, fileName(relative), "workspace", cwd));
  };

  return (
    <WorkspacePage>
      <WorkspacePageHeader
        title={t("scheduledTasks.title")}
        description={t("scheduledTasks.pageDescription")}
        actions={<>
          <button type="button" onClick={() => setForm({ mode: "create" })} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-xs text-accent-fg">
            <Plus size={13} />{t("scheduledTasks.newTask")}
          </button>
          <WorkspacePageRefreshButton label={t("common.refresh")} loading={tasksResult.isFetching} onClick={() => void tasksResult.refetch()} />
        </>}
      />

      {tasksResult.isFetching && tasks.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted"><Loader2 size={18} className="mx-auto mb-2 animate-spin" />{t("common.loading")}</div>
      ) : tasks.length === 0 ? (
        <div className="py-16 text-center">
          <div className="mx-auto mb-3 w-fit text-muted/30"><Clock3 size={40} /></div>
          <p className="text-sm text-muted">{t("scheduledTasks.empty")}</p>
          <p className="mt-1 text-xs text-muted">{t("scheduledTasks.emptyHint")}</p>
          <button type="button" onClick={() => setForm({ mode: "create" })} className="mt-4 min-h-9 rounded-input bg-accent px-3 text-xs text-accent-fg">{t("scheduledTasks.createFirst")}</button>
        </div>
      ) : (
        <div className="mt-5 space-y-2">
          {tasks.map((task) => (
            <TaskRow
              key={task.task_id}
              task={task}
              cwd={cwd}
              selected={task.task_id === selectedId}
              busy={busyTask === task.task_id}
              onSelect={() => { setSelectedId(task.task_id); setSelectedRunId(null); }}
              onToggle={() => void handleToggle(task)}
              onRun={() => void handleRunNow(task)}
            />
          ))}
          {selected && (
            <TaskDetail
              task={selected}
              cwd={cwd}
              busy={busyTask === selected.task_id}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
              onEdit={() => setForm({ mode: "edit", task: selected })}
              onToggle={() => void handleToggle(selected)}
              onRun={() => void handleRunNow(selected)}
              onApprove={() => void handleApprove(selected)}
              onDelete={() => void handleDelete(selected)}
              onOpenFile={openFile}
            />
          )}
        </div>
      )}

      {form && <TaskForm cwd={cwd} task={form.mode === "edit" ? form.task : null} onClose={(taskId) => { setForm(null); if (taskId) { setSelectedId(taskId); setSelectedRunId(null); } }} />}
    </WorkspacePage>
  );
}

/* ── Task list row ── */

function TaskRow({ task, cwd, selected, busy, onSelect, onToggle, onRun }: {
  task: ScheduledTask;
  cwd: string;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  // Per-row history for the last-run badge; cached by react-query, newest first.
  const runsResult = useQuery(scheduledTaskRunsQuery(cwd, task.task_id));
  const lastRun = runsResult.data?.[0];
  return (
    <div className={cn("rounded-card border bg-surface transition-colors", selected ? "border-accent" : "border-border")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-text">{task.name}</span>
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">{t("scheduledTasks.type.literature_digest")}</span>
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted">
              <span>{t("scheduledTasks.nextRun")}：{task.next_run_at ? <span title={`${formatTimestamp(task.next_run_at)} · ${task.schedule.timezone}`}>{nextRunLabel(task.next_run_at, t("scheduledTasks.nextRunImminent"), t("scheduledTasks.nextRunInMinutes"), t("scheduledTasks.nextRunInHours"), t("scheduledTasks.nextRunInDays"))}</span> : <span>{t("scheduledTasks.never")}</span>}</span>
              <span>·</span>
              <span>{t("scheduledTasks.lastRun")}：{lastRun ? <RunStatusBadge status={lastRun.status} /> : <span className="text-muted/60">{t("scheduledTasks.noRunsYet")}</span>}</span>
              <span>·</span>
              <span>{task.enabled ? t("scheduledTasks.enabled") : t("scheduledTasks.disabled")}</span>
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <button type="button" role="switch" aria-checked={task.enabled} aria-label={t("scheduledTasks.enabled")} onClick={onToggle} disabled={busy} className={cn("relative h-5 w-9 rounded-full transition-colors disabled:opacity-50", task.enabled ? "bg-accent" : "bg-surface-2 border border-border-strong")}>
            <span className={cn("absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white transition-all", task.enabled ? "left-[18px]" : "left-1")} />
          </button>
          <button type="button" onClick={onRun} disabled={busy} className="flex min-h-7 items-center gap-1 rounded-input border border-accent-border bg-accent-soft px-2.5 text-[10px] text-accent disabled:opacity-50">
            <Play size={11} />{t("scheduledTasks.runNow")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Task detail ── */

function TaskDetail({ task, cwd, busy, selectedRunId, onSelectRun, onEdit, onToggle, onRun, onApprove, onDelete, onOpenFile }: {
  task: ScheduledTask;
  cwd: string;
  busy: boolean;
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onEdit: () => void;
  onToggle: () => void;
  onRun: () => void;
  onApprove: () => void;
  onDelete: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const runsResult = useQuery(scheduledTaskRunsQuery(cwd, task.task_id));
  const runs = runsResult.data ?? [];
  const pendingApproval = task.approval.status === "pending";
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-text">{task.name}</h2>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">{t("scheduledTasks.type.literature_digest")}</span>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{task.enabled ? t("scheduledTasks.enabled") : t("scheduledTasks.disabled")}</span>
            <span className={cn("rounded px-1.5 py-0.5 text-[10px]", pendingApproval ? "bg-warn/15 text-warn" : "bg-surface-2 text-muted")}>{t(`scheduledTasks.approval.status.${task.approval.status}`)}</span>
          </div>
          <div className="mt-1.5 text-xs text-muted">{t("scheduledTasks.nextRun")}：{task.next_run_at ? <span title={`${formatTimestamp(task.next_run_at)} · ${task.schedule.timezone}`}>{nextRunLabel(task.next_run_at, t("scheduledTasks.nextRunImminent"), t("scheduledTasks.nextRunInMinutes"), t("scheduledTasks.nextRunInHours"), t("scheduledTasks.nextRunInDays"))}</span> : t("scheduledTasks.never")}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <DetailAction primary disabled={busy} onClick={onRun}><Play size={11} />{t("scheduledTasks.runNow")}</DetailAction>
          <DetailAction disabled={busy} onClick={onToggle}>{task.enabled ? <><Pause size={11} />{t("scheduledTasks.pause")}</> : <><Play size={11} />{t("scheduledTasks.resume")}</>}</DetailAction>
          <DetailAction disabled={busy} onClick={onEdit}><Pencil size={11} />{t("scheduledTasks.edit")}</DetailAction>
          <DetailAction danger disabled={busy} onClick={onDelete}><Trash2 size={11} />{t("scheduledTasks.delete")}</DetailAction>
        </div>
      </div>

      {pendingApproval && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-input border border-warn/30 bg-warn/5 px-3 py-2 text-[11px] text-warn">
          <span className="flex min-w-0 flex-1 items-center gap-1.5"><AlertTriangle size={12} className="shrink-0" />{t("scheduledTasks.approval.banner")}</span>
          <button type="button" onClick={onApprove} disabled={busy} className="flex min-h-7 items-center gap-1 rounded-input bg-accent px-2.5 text-[10px] text-accent-fg disabled:opacity-50"><Check size={11} />{t("scheduledTasks.approve")}</button>
        </div>
      )}

      <dl className="mt-4 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <DetailTerm>{t("scheduledTasks.detail.schedule")}</DetailTerm>
        <DetailValue>{humanReadableCron(task.schedule.cron)} <span className="font-mono text-muted">({task.schedule.cron})</span> · {task.schedule.timezone}</DetailValue>
        <DetailTerm>{t("scheduledTasks.detail.query")}</DetailTerm>
        <DetailValue mono>{task.executor.config.query}</DetailValue>
        {task.executor.config.instructions && <><DetailTerm>{t("scheduledTasks.form.instructions")}</DetailTerm><DetailValue>{task.executor.config.instructions}</DetailValue></>}
        <DetailTerm>{t("scheduledTasks.detail.outputPath")}</DetailTerm>
        <DetailValue mono>{task.output.relative_path}</DetailValue>
        <DetailTerm>{t("scheduledTasks.detail.retry")}</DetailTerm>
        <DetailValue>{t("scheduledTasks.detail.retryValue", { count: task.retry.max_attempts })}</DetailValue>
      </dl>

      <h3 className="mt-5 mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{t("scheduledTasks.detail.history")}</h3>
      {runsResult.isFetching && runs.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted"><Loader2 size={15} className="mx-auto mb-1.5 animate-spin" />{t("common.loading")}</div>
      ) : runs.length === 0 ? (
        <p className="rounded-input border border-dashed border-border px-3 py-4 text-center text-xs text-muted">{t("scheduledTasks.detail.noRuns")}</p>
      ) : (
        <div className="space-y-1.5">
          {runs.map((run) => <RunRow key={run.run_id} run={run} selected={run.run_id === selectedRunId} onSelect={() => onSelectRun(run.run_id === selectedRunId ? null : run.run_id)} onOpenFile={onOpenFile} />)}
        </div>
      )}

      {selectedRunId && <SelectedRunLog cwd={cwd} taskId={task.task_id} runId={selectedRunId} />}
    </div>
  );
}

/* ── Run history row ── */

function RunRow({ run, selected, onSelect, onOpenFile }: {
  run: ScheduledTaskRun;
  selected: boolean;
  onSelect: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("rounded-input border px-3 py-2 transition-colors", selected ? "border-accent bg-accent/5" : "border-faint bg-surface-2/50")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <RunStatusBadge status={run.status} />
          <span className="shrink-0 font-mono text-[11px] text-text">{formatTimestamp(run.scheduled_for)}</span>
          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{t(`scheduledTasks.run.trigger.${run.trigger}`)}</span>
          <span className="shrink-0 text-[10px] text-muted">{t("scheduledTasks.run.attempt", { attempt: run.attempt })}</span>
          {run.usage.model_tokens > 0 && <span className="shrink-0 font-mono text-[10px] text-muted">{t("scheduledTasks.run.usage", { tokens: run.usage.model_tokens, cost: run.usage.cost_usd.toFixed(4) })}</span>}
        </button>
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          {run.output_paths.map((path) => (
            <button key={path} type="button" onClick={() => onOpenFile(path)} title={path} className="max-w-[220px] truncate rounded-input border border-border bg-surface px-2 py-1 font-mono text-[10px] text-muted hover:border-accent-border hover:text-accent">{path}</button>
          ))}
          {run.output_paths.length === 0 && <span className="text-[10px] text-muted/60">{t("scheduledTasks.run.noOutputs")}</span>}
        </span>
      </div>
      {run.error && <p className="mt-1.5 break-all font-mono text-[10px] leading-relaxed text-error">{t("scheduledTasks.run.error")}：{run.error}</p>}
    </div>
  );
}

/* ── Selected run log tail ── */

function SelectedRunLog({ cwd, taskId, runId }: { cwd: string; taskId: string; runId: string }) {
  const { t } = useTranslation();
  const runResult = useQuery(scheduledTaskRunQuery(cwd, taskId, runId));
  const run = runResult.data;
  return (
    <div className="mt-2 rounded-input border border-border bg-bg/40 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{t("scheduledTasks.run.log")}</h4>
        {run?.error && <span className="break-all font-mono text-[10px] text-error">{run.error}</span>}
      </div>
      {runResult.isFetching && !run ? (
        <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={12} className="animate-spin" />{t("common.loading")}</div>
      ) : (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text">{run?.log_tail || t("scheduledTasks.run.noLog")}</pre>
      )}
    </div>
  );
}

/* ── Create / edit form ── */

function TaskForm({ cwd, task, onClose }: { cwd: string; task: ScheduledTask | null; onClose: (taskId?: string) => void }) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const [name, setName] = useState(task?.name ?? "");
  const [query, setQuery] = useState(task?.executor.config.query ?? "");
  const [instructions, setInstructions] = useState(task?.executor.config.instructions ?? "");
  const [cron, setCron] = useState(task?.schedule.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(task?.schedule.timezone ?? defaultTimezone());
  const [outputPath, setOutputPath] = useState(task?.output.relative_path ?? "");
  const [saving, setSaving] = useState(false);
  const outputTouched = useRef(task != null);
  const cronValid = isValidCron(cron.trim());
  const [preview, setPreview] = useState<ScheduledTaskPreview | null>(null);
  const [previewComputing, setPreviewComputing] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewToken = useRef(0);

  // Authoritative preview from the server (same cron-parser computation the
  // scheduler uses). Debounced 300ms; the local isValidCron still drives the
  // instant red/green styling. On network failure the local approximation is
  // a silent fallback — preview is auxiliary, never a toast.
  useEffect(() => {
    const expression = cron.trim();
    if (!isValidCron(expression)) {
      previewToken.current += 1;
      setPreview(null);
      setPreviewFailed(false);
      setPreviewComputing(false);
      return;
    }
    setPreviewComputing(true);
    const token = ++previewToken.current;
    const timer = setTimeout(() => {
      previewCron(cwd, expression, timezone)
        .then((result) => { if (previewToken.current === token) { setPreview(result); setPreviewFailed(false); } })
        .catch(() => { if (previewToken.current === token) setPreviewFailed(true); })
        .finally(() => { if (previewToken.current === token) setPreviewComputing(false); });
    }, 300);
    return () => clearTimeout(timer);
  }, [cron, timezone, cwd]);

  // While creating, the output path follows the name until the user edits it.
  useEffect(() => {
    if (outputTouched.current) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
    setOutputPath(`reports/literature/${slug}/`);
  }, [name]);

  const handleSave = async () => {
    if (!name.trim() || !query.trim() || !cronValid || !outputPath.trim() || saving) return;
    setSaving(true);
    const input: ScheduledTaskCreateInput = {
      name: name.trim(),
      type: "literature_digest",
      schedule: { cron: cron.trim(), timezone },
      executor: { kind: "headless_agent", config: { query: query.trim(), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) } },
      output: { relative_path: outputPath.trim() },
    };
    try {
      const saved = task ? await updateScheduledTask(cwd, task.task_id, input) : await createScheduledTask(cwd, input);
      toast(t(task ? "scheduledTasks.updated" : "scheduledTasks.created"), "success");
      if (saved.approval.status === "pending") toast(t("scheduledTasks.approval.pendingHint"), "info");
      onClose(saved.task_id);
    } catch (error) {
      toast(error instanceof Error ? error.message : t("scheduledTasks.saveError"), "error");
      setSaving(false);
    }
  };

  const inputClass = "min-h-9 w-full rounded-input border border-border bg-surface px-3 text-xs text-text outline-none transition-colors placeholder:text-muted focus:border-accent";
  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/65 p-0 backdrop-blur-[2px] sm:p-2 md:p-4"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={t(task ? "scheduledTasks.form.title.edit" : "scheduledTasks.form.title.create")} className="ui-dialog flex h-full w-full flex-col overflow-hidden rounded-none border-0 bg-surface outline-none shadow-none md:h-[min(88vh,840px)] md:w-[min(680px,calc(100vw-32px))] md:rounded-[16px] md:border md:shadow-pop">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text">{t(task ? "scheduledTasks.form.title.edit" : "scheduledTasks.form.title.create")}</h2>
          <button type="button" aria-label={t("common.close")} onClick={() => onClose()} className="rounded-input p-1 text-muted hover:bg-surface-2 hover:text-text"><X size={14} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <FormSection title={t("scheduledTasks.form.what")}>
            <div className="space-y-3">
              <label className="block text-xs text-muted"><span className="mb-1 block">{t("scheduledTasks.form.name")}</span><input aria-label={t("scheduledTasks.form.name")} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("scheduledTasks.form.name")} className={inputClass} /></label>
              <label className="block text-xs text-muted"><span className="mb-1 block">{t("scheduledTasks.form.query")}</span><textarea aria-label={t("scheduledTasks.form.query")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("scheduledTasks.form.queryPlaceholder")} rows={2} className={cn(inputClass, "resize-y py-2")} /></label>
              <label className="block text-xs text-muted"><span className="mb-1 block">{t("scheduledTasks.form.instructions")}</span><textarea aria-label={t("scheduledTasks.form.instructions")} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={t("scheduledTasks.form.instructionsPlaceholder")} rows={2} className={cn(inputClass, "resize-y py-2")} /></label>
            </div>
          </FormSection>

          <FormSection title={t("scheduledTasks.form.when")}>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <button key={preset.key} type="button" onClick={() => setCron(preset.cron)} className={cn("min-h-7 rounded-input border px-2.5 text-[11px] transition-colors", cron === preset.cron ? "border-accent-border bg-accent-soft text-accent" : "border-border text-muted hover:text-text")}>{t(`scheduledTasks.form.preset.${preset.key}`)}</button>
                ))}
              </div>
              <label className="block text-xs text-muted">
                <span className="mb-1 block">{t("scheduledTasks.form.customCron")} <span className="text-muted/60">({t("scheduledTasks.form.cronHint")})</span></span>
                <input aria-label={t("scheduledTasks.form.customCron")} value={cron} onChange={(event) => setCron(event.target.value)} spellCheck={false} className={cn(inputClass, "font-mono", !cronValid && "border-error/60 focus:border-error")} />
                {!cronValid && <span className="mt-1 block text-[10px] text-error">{t("scheduledTasks.form.cronInvalid")}</span>}
              </label>
              {cronValid && (
                <div className="rounded-input border border-border bg-surface-2/60 px-3 py-2">
                  <div className="text-xs text-text">{humanReadableCron(cron.trim())} <span className="font-mono text-muted">({cron.trim()})</span></div>
                  <div className="mt-1.5 text-[10px] text-muted">{t("scheduledTasks.form.nextRuns")}：{previewComputing && <span className="text-muted/70">（{t("scheduledTasks.form.previewComputing")}）</span>}</div>
                  {preview?.valid ? (
                    <ul className="mt-0.5 space-y-0.5">
                      {preview.next_runs.map((run, index) => <li key={index} className="font-mono text-[10px] text-muted">{formatTimestamp(run)}</li>)}
                    </ul>
                  ) : preview && !preview.valid ? (
                    <p className="mt-0.5 text-[10px] text-error">{preview.error}</p>
                  ) : previewFailed ? (
                    <>
                      <ul className="mt-0.5 space-y-0.5">
                        {nextCronRuns(cron.trim(), timezone, 5).map((run, index) => <li key={index} className="font-mono text-[10px] text-muted">{formatTimestamp(run.toISOString())}</li>)}
                      </ul>
                      <p className="mt-1.5 text-[10px] text-muted/70">{t("scheduledTasks.form.previewError")}</p>
                    </>
                  ) : null}
                  <div className="mt-1.5 text-[10px] text-muted/70">{t("scheduledTasks.form.timezoneNote")}</div>
                </div>
              )}
              <label className="block text-xs text-muted"><span className="mb-1 block">{t("scheduledTasks.form.timezone")}</span><select aria-label={t("scheduledTasks.form.timezone")} value={timezone} onChange={(event) => setTimezone(event.target.value)} className={inputClass}>{TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label>
            </div>
          </FormSection>

          <FormSection title={t("scheduledTasks.form.output")}>
            <label className="block text-xs text-muted">
              <span className="mb-1 block">{t("scheduledTasks.form.outputPath")}</span>
              <input aria-label={t("scheduledTasks.form.outputPath")} value={outputPath} onChange={(event) => { outputTouched.current = true; setOutputPath(event.target.value); }} spellCheck={false} className={cn(inputClass, "font-mono", !outputPath.trim() && "border-error/60 focus:border-error")} />
              <span className="mt-1 block text-[10px] text-muted/70">{t("scheduledTasks.form.outputPathHint")}</span>
            </label>
          </FormSection>

          <FormSection title={t("scheduledTasks.form.confirm")}>
            <p className="text-[11px] leading-relaxed text-muted">{t("scheduledTasks.form.approvalHint")}</p>
          </FormSection>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={() => onClose()} className="min-h-9 rounded-input border border-border px-3 text-xs text-muted hover:text-text">{t("common.cancel")}</button>
          <button type="button" onClick={() => void handleSave()} disabled={saving || !name.trim() || !query.trim() || !cronValid || !outputPath.trim()} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-xs text-accent-fg disabled:opacity-50">
            {saving && <Loader2 size={12} className="animate-spin" />}{t("scheduledTasks.form.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ── Small presentational helpers ── */

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-5"><h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{title}</h3>{children}</section>;
}

function DetailAction({ danger = false, primary = false, disabled = false, onClick, children }: { danger?: boolean; primary?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} disabled={disabled} className={cn("flex min-h-7 items-center gap-1.5 rounded-input border px-2.5 text-[10px] transition-colors disabled:opacity-50", primary ? "border-accent-border bg-accent-soft text-accent hover:bg-accent/10" : danger ? "border-error/30 text-error hover:bg-error/5" : "border-border text-muted hover:border-border-strong hover:text-text")}>{children}</button>;
}

function DetailTerm({ children }: { children: React.ReactNode }) { return <dt className="text-muted">{children}</dt>; }
function DetailValue({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) { return <dd className={cn("min-w-0 break-all text-text", mono && "font-mono text-[11px]")}>{children}</dd>; }

function RunStatusBadge({ status }: { status: ScheduledTaskRunStatus }) {
  const { t } = useTranslation();
  const icon = status === "succeeded" ? <Check size={12} className="shrink-0 text-ok" />
    : status === "failed" ? <X size={12} className="shrink-0 text-error" />
    : status === "skipped" ? <Ban size={12} className="shrink-0 text-muted" />
    : status === "needs_attention" ? <AlertTriangle size={12} className="shrink-0 text-warn" />
    : status === "running" ? <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
    : <CircleDashed size={12} className="shrink-0 text-muted" />;
  return <span className={cn("inline-flex shrink-0 items-center gap-1 text-[10px] font-medium", status === "succeeded" && "text-ok", status === "failed" && "text-error", status === "needs_attention" && "text-warn", (status === "skipped" || status === "pending") && "text-muted", status === "running" && "text-accent")}>{icon}{t(`scheduledTasks.run.status.${status}`)}</span>;
}

function nextRunLabel(value: string, imminent: string, inMinutes: string, inHours: string, inDays: string): string {
  const diff = Date.parse(value) - Date.now();
  if (diff <= 0) return imminent;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return inMinutes.replace("{{minutes}}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return inHours.replace("{{hours}}", String(hours));
  return inDays.replace("{{days}}", String(Math.floor(hours / 24)));
}

function workspaceRelativePath(path: string, cwd: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const workspace = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized.startsWith("/")) return normalized.replace(/^\.\//, "");
  return normalized.startsWith(`${workspace}/`) ? normalized.slice(workspace.length + 1) : null;
}

function fileName(path: string): string { return path.split("/").pop() || path; }

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
