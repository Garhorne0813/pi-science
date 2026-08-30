import { useState } from "react";
import { Check, ExternalLink, ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useFeedback } from "../../components/feedback/feedback-context";
import { createScheduledTask, invalidateScheduledTasks, runScheduledTaskNow } from "../../lib/scheduled-tasks";
import { TaskProposalCard } from "./TaskProposalCard";
import type { ScheduledTaskProposal } from "./model";

export function ConversationScheduledProposal({ initial, cwd }: { initial: ScheduledTaskProposal; cwd: string }) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const [proposal, setProposal] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ taskId: string; nextRunAt: string | null; approvalPending: boolean } | null>(null);

  const confirm = async (runNow: boolean) => {
    setSaving(true);
    try {
      const task = await createScheduledTask(cwd, {
        name: proposal.title,
        display: { title: proposal.title, schedule_text: proposal.schedule.display_text, action_summary: proposal.action_summary },
        delivery_policy: proposal.delivery_policy,
        schedule: proposal.schedule.canonical,
        executor: { kind: "literature_digest", config: { query: proposal.query, providers: proposal.providers, instructions: proposal.focus, max_results: 30, language: "zh-CN" } },
        output: { relative_root: "outputs/scheduled" },
        retry: { max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 },
        budget: { max_wall_time_seconds: 900 },
        misfire_policy: "coalesce_latest",
      });
      if (runNow && task.approval.status !== "pending") await runScheduledTaskNow(task.task_id, cwd);
      invalidateScheduledTasks(cwd, task.task_id);
      setCreated({ taskId: task.task_id, nextRunAt: task.next_run_at, approvalPending: task.approval.status === "pending" });
      toast(t(runNow && task.approval.status !== "pending" ? "st.createdAndRunning" : "st.created"), "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("st.saveError"), "error");
    } finally {
      setSaving(false);
    }
  };

  if (!created) return <TaskProposalCard proposal={proposal} saving={saving} onChange={setProposal} onConfirm={(runNow) => void confirm(runNow)} compact />;
  return (
    <section aria-label={t("st.createdCard")} className="rounded-card border border-ok/30 bg-ok-fill p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-ok-text"><Check size={15} />{t("st.scheduledDone")}</div>
      <h3 className="mt-2 text-sm font-medium text-text">{proposal.title}</h3>
      <p className="mt-1 text-xs text-muted">{proposal.schedule.display_text}</p>
      {created.nextRunAt && <p className="mt-1 text-xs text-muted">{t("st.nextRun", { time: new Date(created.nextRunAt).toLocaleString() })}</p>}
      {created.approvalPending && <p className="mt-2 flex items-center gap-1.5 text-xs text-warn-text"><ShieldAlert size={13} />{t("st.createdApprovalPending")}</p>}
      <button type="button" onClick={() => navigate(`/workspace/${encodeURIComponent(cwd)}/scheduled-tasks?task=${encodeURIComponent(created.taskId)}`)} className="mt-3 flex min-h-8 items-center gap-1.5 rounded-input border border-border bg-surface px-3 text-xs text-text"><ExternalLink size={12} />{t("st.viewTask")}</button>
    </section>
  );
}
