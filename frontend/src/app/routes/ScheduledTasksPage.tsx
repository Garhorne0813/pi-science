import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, CalendarClock, ChevronDown, ChevronRight, Clock3, ExternalLink,
  Loader2, Pause, Play, Plus, ShieldAlert, Trash2, X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn, useUiStore } from "../../lib/ui";
import { useFeedback } from "../../components/feedback/feedback-context";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { fileInspectorForPath } from "../../lib/artifacts";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";
import { queryClient } from "../../lib/client/query-client";
import {
  LITERATURE_PROVIDERS, approveScheduledTask, createScheduledTask, deleteScheduledTask, executionDeepLink,
  invalidateScheduledTasks, isConflict, manualRunToRow, pauseScheduledTask, patchScheduledTask,
  previewScheduledSchedule, resumeScheduledTask, runAttemptsQuery, runScheduledTaskNow, scheduledErrorCode,
  scheduledTasksKey, scheduledTasksQuery, scheduledTasksStatusQuery, taskDetailQuery, taskRunsQuery,
  timezoneOptions,
} from "../../lib/scheduled-tasks";
import type {
  LiteratureProvider, MisfirePolicy, PreviewItem, RetryPolicy, RunRowView, ScheduledSchedule,
  ScheduledTaskAttempt, ScheduledTaskView, TaskListSummary,
} from "../../lib/scheduled-tasks";

type ScheduleType = ScheduledSchedule["type"];

interface FormState {
  name: string;
  scheduleType: ScheduleType;
  onceAt: string;
  intervalSeconds: number;
  cronExpression: string;
  timezone: string;
  query: string;
  providers: LiteratureProvider[];
  instructions: string;
  maxResults: number;
  language: "zh-CN" | "en";
  relativeRoot: string;
  retry: RetryPolicy;
  misfirePolicy: MisfirePolicy;
  wallTime: number;
}

const DEFAULT_FORM: FormState = {
  name: "",
  scheduleType: "cron",
  onceAt: "",
  intervalSeconds: 3600,
  cronExpression: "0 9 * * *",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  query: "",
  providers: ["pubmed"],
  instructions: "",
  maxResults: 30,
  language: "zh-CN",
  relativeRoot: "outputs/scheduled",
  retry: { max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 },
  misfirePolicy: "coalesce_latest",
  wallTime: 900,
};

export function ScheduledTasksPage() {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const openInspector = useUiStore((state) => state.openInspector);
  const [searchParams] = useSearchParams();

  // §13.4: the initial render issues exactly one collection request; the status
  // probe and any per-task reads are separate concerns that never fan out here.
  const statusResult = useQuery(scheduledTasksStatusQuery());
  const tasksResult = useQuery(scheduledTasksQuery(workspaceCwd));
  const tasks = useMemo(() => tasksResult.data?.items ?? [], [tasksResult.data]);
  const degraded = statusResult.isError || statusResult.data?.feature_enabled === false || statusResult.data?.sqlite_ready === false;

  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(() => searchParams.get("task"));
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [formTarget, setFormTarget] = useState<ScheduledTaskView | "create" | null>(null);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);

  const detailResult = useQuery({ ...taskDetailQuery(workspaceCwd, expandedTaskId ?? ""), enabled: Boolean(expandedTaskId) });
  const runsResult = useQuery({ ...taskRunsQuery(workspaceCwd, expandedTaskId ?? ""), enabled: Boolean(expandedTaskId) });
  const attemptsResult = useQuery(runAttemptsQuery(workspaceCwd, expandedTaskId ?? "", selectedRunId));
  const expandedSummary = tasks.find((task) => task.task_id === expandedTaskId) ?? null;

  useEffect(() => {
    const error = tasksResult.error;
    if (error) toast(error instanceof Error ? error.message : t("st.loadError"), "error");
  }, [tasksResult.error, t, toast]);

  const toggleExpanded = (taskId: string) => {
    setArmedDeleteId(null);
    if (expandedTaskId === taskId) {
      setExpandedTaskId(null);
      setSelectedRunId(null);
      return;
    }
    setExpandedTaskId(taskId);
    setSelectedRunId(null);
  };

  const openFile = (path: string) => {
    const relative = path.replaceAll("\\", "/").startsWith(`${workspaceCwd}/`)
      ? path.slice(workspaceCwd.length + 1)
      : path.replace(/^\.\//, "");
    openInspector(fileInspectorForPath(relative, relative.split("/").pop() || relative, "workspace", workspaceCwd));
  };

  const runNow = async (task: TaskListSummary) => {
    try {
      const result = await runScheduledTaskNow(task.task_id, workspaceCwd);
      // Optimistically insert the 202 pending run; polling keeps it fresh.
      const key = scheduledTasksKey(workspaceCwd, task.task_id, "runs");
      const existing = queryClient.getQueryData<RunRowView[]>(key);
      queryClient.setQueryData<RunRowView[]>(key, [manualRunToRow(result.run), ...(existing ?? [])]);
      toast(t("st.runStarted", { name: task.name }), "success");
    } catch (error) {
      toastActionError(error, t("st.runError"), toast);
    }
  };

  const togglePause = async (task: TaskListSummary) => {
    try {
      if (task.lifecycle_status === "paused") await resumeScheduledTask(task.task_id, workspaceCwd, task.revision);
      else await pauseScheduledTask(task.task_id, workspaceCwd, task.revision);
      invalidateScheduledTasks(workspaceCwd, task.task_id);
    } catch (error) {
      toastActionError(error, t("st.pauseError"), toast);
    }
  };

  const deleteTask = async (task: TaskListSummary) => {
    if (armedDeleteId !== task.task_id) {
      setArmedDeleteId(task.task_id);
      return;
    }
    setArmedDeleteId(null);
    try {
      await deleteScheduledTask(task.task_id, workspaceCwd, task.revision);
      if (expandedTaskId === task.task_id) setExpandedTaskId(null);
      invalidateScheduledTasks(workspaceCwd);
      toast(t("st.deleted"), "success");
    } catch (error) {
      if (isConflict(error) && scheduledErrorCode(error) === "TASK_HAS_ACTIVE_RUN") toast(t("st.activeRunDeleteBlocked"), "error");
      else toastActionError(error, t("st.deleteError"), toast);
      invalidateScheduledTasks(workspaceCwd, task.task_id);
    }
  };

  const openEdit = (taskId: string) => {
    void queryClient.fetchQuery(taskDetailQuery(workspaceCwd, taskId))
      .then((task) => setFormTarget(task))
      .catch((error) => toastActionError(error, t("st.loadError"), toast));
  };

  return (
    <WorkspacePage>
      <WorkspacePageHeader
        title={t("st.title")}
        description={t("st.description")}
        actions={<>
          <button
            type="button"
            onClick={() => setFormTarget("create")}
            disabled={degraded}
            title={degraded ? t("st.degradedBanner") : undefined}
            className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={14} /> {t("st.create")}
          </button>
          <WorkspacePageRefreshButton label={t("common.refresh")} loading={tasksResult.isFetching} onClick={() => void tasksResult.refetch()} />
        </>}
      />

      {degraded && (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-card border border-warn/40 bg-warn-fill px-4 py-3 text-xs text-warn-text">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{statusResult.data && !statusResult.isError ? t("st.degradedDetail") : t("st.degradedBanner")}</span>
        </div>
      )}

      {(formTarget !== null) && (
        <TaskFormSection
          cwd={workspaceCwd}
          target={formTarget}
          onClose={() => setFormTarget(null)}
          onSaved={(taskId) => {
            setFormTarget(null);
            invalidateScheduledTasks(workspaceCwd, taskId);
            setExpandedTaskId(taskId);
          }}
        />
      )}

      <div className="mt-4 overflow-hidden rounded-card border border-border bg-surface">
        {tasksResult.isLoading && tasks.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted"><Loader2 size={18} className="mx-auto mb-2 animate-spin" />{t("common.loading")}</div>
        ) : tasks.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">{degraded ? t("st.emptyDegraded") : t("st.empty")}</p>
        ) : (
          <ul data-testid="scheduled-task-list" className="divide-y divide-faint">
            {tasks.map((task) => (
              <li key={task.task_id}>
                <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5", expandedTaskId === task.task_id && "bg-surface-selected/60")}>
                  <button
                    type="button"
                    aria-expanded={expandedTaskId === task.task_id}
                    onClick={() => toggleExpanded(task.task_id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {expandedTaskId === task.task_id ? <ChevronDown size={14} className="shrink-0 text-muted" /> : <ChevronRight size={14} className="shrink-0 text-muted" />}
                    <span className="min-w-0 truncate text-sm font-medium text-text">{task.name}</span>
                    <StatusBadge tone={lifecycleTone(task.lifecycle_status)} label={t(`st.lifecycle.${task.lifecycle_status}`)} />
                    <StatusBadge tone={approvalTone(task.approval_status)} label={t(`st.approvalShort.${task.approval_status}`)} />
                  </button>
                  <span className="font-mono text-[10px] text-muted">{scheduleSummary(task.schedule)}</span>
                  <span className="font-mono text-[10px] tabular-nums text-muted">{task.next_run_at ? formatTimestamp(task.next_run_at) : "—"}</span>
                  {task.latest_run && <StatusDot status={task.latest_run.status} label={t(`st.runStatus.${task.latest_run.status}`)} />}
                  <div className="flex items-center gap-1">
                    <ActionButton icon={<Play size={12} />} label={t("st.runNow")} disabled={degraded} onClick={() => void runNow(task)} />
                    <ActionButton icon={task.lifecycle_status === "paused" ? <Play size={12} /> : <Pause size={12} />} label={task.lifecycle_status === "paused" ? t("st.resume") : t("st.pause")} onClick={() => void togglePause(task)} />
                    <ActionButton icon={<CalendarClock size={12} />} label={t("common.edit")} onClick={() => openEdit(task.task_id)} />
                    <ActionButton icon={<Trash2 size={12} />} label={armedDeleteId === task.task_id ? t("st.confirmDelete") : t("common.delete")} danger={armedDeleteId === task.task_id} onClick={() => void deleteTask(task)} />
                  </div>
                </div>
                {expandedTaskId === task.task_id && (
                  <TaskExpansion
                    summary={expandedSummary}
                    detail={detailResult.data ?? null}
                    detailLoading={detailResult.isLoading}
                    runs={runsResult.data ?? []}
                    runsLoading={runsResult.isLoading}
                    selectedRunId={selectedRunId}
                    onSelectRun={setSelectedRunId}
                    attempts={attemptsResult.data ?? []}
                    attemptsLoading={attemptsResult.isLoading && Boolean(selectedRunId)}
                    onOpenExecution={(executionId) => navigate(executionDeepLink(workspaceCwd, executionId))}
                    onOpenFile={openFile}
                    onRefresh={() => invalidateScheduledTasks(workspaceCwd, task.task_id)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="sticky bottom-0 mt-6 -mx-4 border-t border-faint bg-bg px-4 py-2.5 text-center text-[11px] text-muted sm:-mx-6 sm:px-6">
        {t("st.localOnlyNote")}
      </footer>
    </WorkspacePage>
  );
}

function TaskExpansion({ summary, detail, detailLoading, runs, runsLoading, selectedRunId, onSelectRun, attempts, attemptsLoading, onOpenExecution, onOpenFile, onRefresh }: {
  summary: TaskListSummary | null;
  detail: ScheduledTaskView | null;
  detailLoading: boolean;
  runs: RunRowView[];
  runsLoading: boolean;
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  attempts: ScheduledTaskAttempt[];
  attemptsLoading: boolean;
  onOpenExecution: (executionId: string) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const selectedRun = runs.find((run) => run.run_id === selectedRunId) ?? null;
  return (
    <div className="border-t border-faint bg-bg/40 px-4 py-3" data-testid={`task-expansion-${summary?.task_id ?? "unknown"}`}>
      {!detail && detailLoading && <p className="flex items-center gap-2 py-1 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{t("common.loading")}</p>}
      {detail && <ApprovalBanner task={detail} onApproved={onRefresh} />}
      <h4 className="mb-2 mt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{t("st.runHistory")}</h4>
      {runsLoading ? (
        <p className="flex items-center gap-2 py-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{t("common.loading")}</p>
      ) : runs.length === 0 ? (
        <p className="py-2 text-xs text-muted">{t("st.noRuns")}</p>
      ) : (
        <div className="overflow-hidden rounded-input border border-border">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border bg-surface-2/60 text-[10px] uppercase tracking-wide text-muted">
                <th scope="col" className="px-3 py-1.5 font-semibold">{t("runs.field.status")}</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">{t("st.scheduledFor")}</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">{t("st.businessDate")}</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">{t("st.attempts")}</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">{t("st.errorCode")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.run_id}
                  onClick={() => onSelectRun(selectedRunId === run.run_id ? null : run.run_id)}
                  aria-selected={selectedRunId === run.run_id}
                  className={cn("cursor-pointer border-b border-faint last:border-b-0 hover:bg-surface-hover", selectedRunId === run.run_id && "bg-surface-selected/60")}
                >
                  <td className="px-3 py-1.5"><StatusDot status={run.status} label={t(`st.runStatus.${run.status}`)} /></td>
                  <td className="px-3 py-1.5 font-mono text-[11px] tabular-nums text-text">{formatTimestamp(run.scheduled_for)}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-muted">{run.business_date}</td>
                  <td className="px-3 py-1.5 tabular-nums text-muted">{run.attempt_count}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-error-text">{run.error_code ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedRun && (
        <div className="mt-3 space-y-3 rounded-input border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{t("st.attemptList")}</h4>
            {attemptsLoading && <Loader2 size={12} className="animate-spin text-muted" />}
          </div>
          {attempts.length === 0 && !attemptsLoading ? (
            <p className="text-xs text-muted">{t("st.noAttempts")}</p>
          ) : (
            <ul className="space-y-1">
              {attempts.map((attempt) => (
                <li key={attempt.attempt_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-input px-2 py-1 text-xs hover:bg-surface-hover">
                  <span className="tabular-nums text-muted">#{attempt.attempt_no}</span>
                  <StatusDot status={attempt.status} label={t(`st.runStatus.${attempt.status}`)} />
                  {attempt.error_code && <span className="font-mono text-[11px] text-error-text">{attempt.error_code}</span>}
                  <button
                    type="button"
                    onClick={() => attempt.execution_id && onOpenExecution(String(attempt.execution_id))}
                    className="ml-auto flex items-center gap-1 rounded-input border border-border px-2 py-0.5 font-mono text-[10px] text-muted transition-colors hover:border-accent-border hover:text-accent"
                  >
                    <ExternalLink size={11} /> {String(attempt.execution_id)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selectedRun.output_paths.length > 0 && (
            <div>
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{t("st.outputs")}</h4>
              <ul className="space-y-1">
                {selectedRun.output_paths.map((path) => (
                  <li key={path}>
                    <button type="button" onClick={() => onOpenFile(path)} className="flex w-full items-center gap-2 break-all rounded-input border border-border bg-surface-2 px-2 py-1 text-left font-mono text-[11px] text-text transition-colors hover:border-accent-border hover:bg-accent-soft">
                      <ExternalLink size={11} className="shrink-0 text-muted" /> {path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** docs §9: sensitive egress requires an explicit user confirmation carrying
 * expected_revision + scope_hash + categories; editing the scope invalidates it. */
function ApprovalBanner({ task, onApproved }: { task: ScheduledTaskView; onApproved: () => void }) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Any scope/revision change resets the explicit confirmation (docs §9.4).
  useEffect(() => setConfirmed(false), [task.approval.scope_hash, task.revision]);
  if (task.approval.status !== "pending") return null;
  const staleApproval = task.approval.approved_revision !== null && task.approval.approved_revision < task.revision;

  const approve = async () => {
    setSubmitting(true);
    try {
      await approveScheduledTask(task.task_id, task.workspace_path, { expected_revision: task.revision, approval_scope_hash: task.approval.scope_hash, categories: task.approval.categories });
      toast(t("st.approved"), "success");
      onApproved();
    } catch (error) {
      toastActionError(error, t("st.approveError"), toast);
      onApproved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div role="alert" data-testid="approval-banner" className="rounded-card border border-warn/40 bg-warn-fill px-4 py-3 text-xs text-warn-text">
      <div className="flex items-center gap-2 font-semibold"><ShieldAlert size={14} />{t("st.approvalTitle")}</div>
      {staleApproval && <p className="mt-1">{t("st.approvalStaleHint")}</p>}
      {task.approval.categories.length > 0 && (
        <p className="mt-1">{t("st.approvalCategories")}: {task.approval.categories.map((category) => <span key={category} className="mr-1 inline-block rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text">{category}</span>)}</p>
      )}
      {task.approval.terms.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {task.approval.terms.map((term) => <li key={term}>{term}</li>)}
        </ul>
      )}
      <label className="mt-2 flex items-center gap-2 text-text">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="accent-accent" />
        {t("st.approvalConfirmCheck")}
      </label>
      <button
        type="button"
        disabled={!confirmed || submitting}
        onClick={() => void approve()}
        className="mt-2 min-h-8 rounded-input border border-warn/60 bg-surface px-3 text-xs font-medium text-warn-text transition-colors hover:bg-warn/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? t("st.approving") : t("st.approve")}
      </button>
    </div>
  );
}

function TaskFormSection({ cwd, target, onClose, onSaved }: { cwd: string; target: ScheduledTaskView | "create"; onClose: () => void; onSaved: (taskId: string) => void }) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const zones = useMemo(timezoneOptions, []);
  const [form, setForm] = useState<FormState>(() => (target === "create" ? DEFAULT_FORM : formFromTask(target)));
  const [preview, setPreview] = useState<{ items: PreviewItem[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const editing = target !== "create";
  const canSubmit = Boolean(form.name.trim()) && Boolean(form.query.trim()) && form.providers.length > 0 && (form.scheduleType !== "once" || Boolean(form.onceAt));

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  const schedule = (): ScheduledSchedule => {
    if (form.scheduleType === "once") return { type: "once", at: wallTimeToRfc3339(form.onceAt, form.timezone), timezone: form.timezone };
    if (form.scheduleType === "interval") return { type: "interval", every_seconds: Math.max(300, Math.floor(form.intervalSeconds) || 300), anchor_at: new Date().toISOString(), timezone: form.timezone };
    return { type: "cron", expression: form.cronExpression.trim(), timezone: form.timezone };
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await previewScheduledSchedule(cwd, schedule()));
    } catch (error) {
      setPreview(null);
      toast(error instanceof Error ? error.message : t("st.previewError"), "error");
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setConflict(false);
    const body = {
      name: form.name.trim(),
      schedule: schedule(),
      executor: {
        kind: "literature_digest" as const,
        config: {
          query: form.query.trim(),
          providers: form.providers,
          instructions: form.instructions.trim() || undefined,
          max_results: Math.min(100, Math.max(1, Math.floor(form.maxResults) || 30)),
          language: form.language,
        },
      },
      output: { relative_root: form.relativeRoot.trim() },
      retry: form.retry,
      budget: { max_wall_time_seconds: form.wallTime },
      misfire_policy: form.misfirePolicy,
    };
    try {
      const saved = target === "create"
        ? await createScheduledTask(cwd, body)
        : await patchScheduledTask(target.task_id, cwd, target.revision, body);
      toast(t(editing ? "st.saved" : "st.created"), "success");
      onSaved(saved.task_id);
    } catch (error) {
      if (isConflict(error)) {
        // Never overwrite the user's edits: refetch the authoritative revision
        // and surface the conflict instead of silently re-PATCHing (docs §13.6).
        setConflict(true);
        invalidateScheduledTasks(cwd, target === "create" ? undefined : target.task_id);
      } else {
        toast(error instanceof Error ? error.message : t("st.saveError"), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label={t(editing ? "st.edit" : "st.create")} className="mt-4 rounded-card border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-text">{t(editing ? "st.editTitle" : "st.createTitle")}</h2>
        <button type="button" aria-label={t("common.close")} onClick={onClose} className="rounded-input p-1 text-muted transition-colors hover:bg-surface-hover hover:text-text"><X size={14} /></button>
      </div>

      {conflict && (
        <div role="alert" className="mb-3 rounded-input border border-error/25 bg-error-fill px-3 py-2 text-xs text-error-text">
          {t("st.conflictNotice")}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t("st.field.name")}>
          <input value={form.name} onChange={(event) => update("name", event.target.value)} className={inputClass} />
        </Field>
        <Field label={t("st.field.scheduleType")}>
          <select value={form.scheduleType} onChange={(event) => update("scheduleType", event.target.value as ScheduleType)} className={inputClass}>
            <option value="once">{t("st.schedule.once")}</option>
            <option value="interval">{t("st.schedule.interval")}</option>
            <option value="cron">{t("st.schedule.cron")}</option>
          </select>
        </Field>
        {form.scheduleType === "once" && (
          <Field label={t("st.schedule.onceAt")} hint={t("st.schedule.onceAtHint")}>
            <input type="datetime-local" value={form.onceAt} onChange={(event) => update("onceAt", event.target.value)} className={inputClass} />
          </Field>
        )}
        {form.scheduleType === "interval" && (
          <Field label={t("st.schedule.everySeconds")} hint={t("st.schedule.intervalMin")}>
            <input type="number" min={300} value={form.intervalSeconds} onChange={(event) => update("intervalSeconds", Number(event.target.value))} className={inputClass} />
          </Field>
        )}
        {form.scheduleType === "cron" && (
          <Field label={t("st.field.cronExpression")} hint={t("st.schedule.cronHint")}>
            <input value={form.cronExpression} onChange={(event) => update("cronExpression", event.target.value)} className={`${inputClass} font-mono`} placeholder="0 9 * * *" />
          </Field>
        )}
        <Field label={t("st.field.timezone")}>
          <select value={form.timezone} onChange={(event) => update("timezone", event.target.value)} className={inputClass}>
            {!zones.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
            {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </Field>

        <Field label={t("st.field.query")}>
          <input value={form.query} onChange={(event) => update("query", event.target.value)} className={inputClass} />
        </Field>
        <Field label={t("st.field.providers")}>
          <div className="flex flex-wrap gap-1.5">
            {LITERATURE_PROVIDERS.map((provider) => {
              const active = form.providers.includes(provider);
              return (
                <button
                  key={provider}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update("providers", active ? form.providers.filter((item) => item !== provider) : [...form.providers, provider])}
                  className={cn("rounded-input border px-2 py-1 text-[11px] transition-colors", active ? "border-accent-border bg-accent-soft text-accent" : "border-border bg-surface text-muted hover:text-text")}
                >
                  {provider}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label={t("st.field.instructions")}>
          <textarea value={form.instructions} onChange={(event) => update("instructions", event.target.value)} rows={2} className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("st.field.maxResults")}>
            <input type="number" min={1} max={100} value={form.maxResults} onChange={(event) => update("maxResults", Number(event.target.value))} className={inputClass} />
          </Field>
          <Field label={t("st.field.language")}>
            <select value={form.language} onChange={(event) => update("language", event.target.value as "zh-CN" | "en")} className={inputClass}>
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>

        <Field label={t("st.field.outputRoot")}>
          <input value={form.relativeRoot} onChange={(event) => update("relativeRoot", event.target.value)} className={`${inputClass} font-mono`} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("st.retry.maxAttempts")}>
            <input type="number" min={1} max={5} value={form.retry.max_attempts} onChange={(event) => update("retry", { ...form.retry, max_attempts: Number(event.target.value) })} className={inputClass} />
          </Field>
          <Field label={t("st.misfirePolicy")}>
            <select value={form.misfirePolicy} onChange={(event) => update("misfirePolicy", event.target.value as MisfirePolicy)} className={inputClass}>
              <option value="coalesce_latest">{t("st.misfire.coalesce_latest")}</option>
              <option value="skip">{t("st.misfire.skip")}</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void runPreview()} disabled={previewing || !canSubmit} className="flex min-h-8 items-center gap-1.5 rounded-input border border-border bg-surface px-3 text-xs text-text transition-colors hover:border-accent-border hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50">
          {previewing ? <Loader2 size={12} className="animate-spin" /> : <Clock3 size={12} />} {t("st.preview")}
        </button>
        <button type="button" onClick={() => void save()} disabled={saving || !canSubmit} className="flex min-h-8 items-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? t("st.saving") : t("common.save")}
        </button>
        <button type="button" onClick={onClose} className="min-h-8 rounded-input border border-border px-3 text-xs text-muted transition-colors hover:text-text">{t("common.cancel")}</button>
      </div>

      {preview && (
        <div data-testid="schedule-preview" className="mt-3 rounded-input border border-border bg-surface-2 p-3">
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{t("st.previewTitle")}</h4>
          {preview.items.map((item, index) => (
            <div key={`${item.utc}:${index}`} className="font-mono text-[11px] leading-relaxed text-text">
              <div>{item.local} {form.timezone}</div>
              <div className="text-muted">{formatUtcLabel(item.utc)} UTC</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const inputClass = "min-h-9 w-full rounded-input border border-border bg-surface px-3 text-xs text-text outline-none transition-colors placeholder:text-muted focus:border-accent";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted">{label}{hint && <span className="ml-1 font-normal text-muted/70">({hint})</span>}</span>
      {children}
    </label>
  );
}

function ActionButton({ icon, label, onClick, disabled = false, danger = false }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        "flex min-h-7 items-center gap-1 rounded-input border px-2 text-[10px] transition-colors",
        danger ? "border-error/30 text-error-text hover:bg-error/10" : "border-border text-muted hover:border-border-strong hover:text-text",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {icon}{danger ? label : ""}
    </button>
  );
}

function StatusBadge({ tone, label }: { tone: "ok" | "warn" | "muted" | "error"; label: string }) {
  return (
    <span className={cn(
      "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
      tone === "ok" && "bg-ok-fill text-ok-text",
      tone === "warn" && "bg-warn-fill text-warn-text",
      tone === "error" && "bg-error-fill text-error-text",
      tone === "muted" && "bg-surface-2 text-muted",
    )}>{label}</span>
  );
}

function StatusDot({ status, label }: { status: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]" title={label}>
      <span className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        status === "succeeded" && "bg-ok",
        status === "running" && "animate-pulse bg-accent",
        status === "pending" && "bg-muted",
        (status === "failed" || status === "timed_out") && "bg-error",
        (status === "interrupted" || status === "cancelled" || status === "skipped") && "bg-warn",
      )} aria-hidden />
      {label}
    </span>
  );
}

function lifecycleTone(status: TaskListSummary["lifecycle_status"]): "ok" | "muted" | "warn" {
  if (status === "active") return "ok";
  if (status === "paused") return "warn";
  return "muted";
}

function approvalTone(status: TaskListSummary["approval_status"]): "ok" | "muted" | "warn" {
  if (status === "approved") return "ok";
  if (status === "pending") return "warn";
  return "muted";
}

function scheduleSummary(schedule: ScheduledSchedule): string {
  if (schedule.type === "once") return `${formatTimestamp(schedule.at)} · ${schedule.timezone}`;
  if (schedule.type === "interval") return `every ${Math.round(schedule.every_seconds / 60)}m · ${schedule.timezone}`;
  return `${schedule.expression} · ${schedule.timezone}`;
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatUtcLabel(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function formFromTask(task: ScheduledTaskView): FormState {
  const config = task.executor.config;
  const schedule = task.schedule;
  return {
    name: task.name,
    scheduleType: schedule.type,
    onceAt: schedule.type === "once" ? instantToWallTime(schedule.at, schedule.timezone) : "",
    intervalSeconds: schedule.type === "interval" ? schedule.every_seconds : DEFAULT_FORM.intervalSeconds,
    cronExpression: schedule.type === "cron" ? schedule.expression : DEFAULT_FORM.cronExpression,
    timezone: schedule.timezone,
    query: config.query,
    providers: [...config.providers],
    instructions: config.instructions ?? "",
    maxResults: config.max_results,
    language: config.language,
    relativeRoot: task.output.relative_root,
    retry: { ...task.retry },
    misfirePolicy: task.misfire_policy,
    wallTime: task.budget.max_wall_time_seconds,
  };
}

/** Wall-clock "YYYY-MM-DDTHH:mm" in `timeZone` → RFC 3339 UTC instant. */
function wallTimeToRfc3339(local: string, timeZone: string): string {
  if (!local) return "";
  const [date, time = "00:00"] = local.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(guess - zoneOffsetMs(guess, timeZone)).toISOString();
}

/** Instant → wall clock in `timeZone`, for prefilling the once-at field. */
function instantToWallTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

/** One place mapping action failures to user copy; keeps server error text visible. */
function toastActionError(error: unknown, fallbackMessage: string, toast: (message: string, tone?: "success" | "error") => void): void {
  toast(error instanceof Error && error.message ? error.message : fallbackMessage, "error");
}
