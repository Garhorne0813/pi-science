import { genericDetails, record, text, toolErrorSummary } from "./shared";
import type { ActivityDetailView, ActivityRenderer } from "./types";

interface ChildTask {
  agent?: string;
  task?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  outputTruncated?: boolean;
}

function taskRecord(value: unknown): ChildTask | null {
  const item = record(value);
  if (!item) return null;
  return {
    ...(text(item.agent) ? { agent: text(item.agent) } : {}),
    ...(text(item.task) ? { task: text(item.task) } : {}),
    ...(text(item.output) ? { output: text(item.output) } : {}),
    ...(text(item.error) ? { error: text(item.error) } : {}),
    ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    ...(item.outputTruncated === true ? { outputTruncated: true } : {}),
  };
}

function childTasks(source: Parameters<ActivityRenderer["compact"]>[0]["source"]): { mode: string; tasks: ChildTask[] } {
  const input = source.input ?? {};
  const details = record(source.details) ?? {};
  const resultValues = Array.isArray(details.results) ? details.results : [];
  const inputValues = Array.isArray(input.tasks) ? input.tasks : Array.isArray(input.chain) ? input.chain : input.agent || input.task ? [input] : [];
  const size = Math.max(resultValues.length, inputValues.length);
  const tasks: ChildTask[] = [];
  for (let index = 0; index < size; index++) {
    const request = taskRecord(inputValues[index]);
    const result = taskRecord(resultValues[index]);
    if (request || result) tasks.push({ ...request, ...result, task: result?.task ?? request?.task });
  }
  const fallbackMode = Array.isArray(input.chain) ? "chain" : Array.isArray(input.tasks) ? "parallel" : "single";
  const rawMode = text(details.mode);
  const mode = rawMode === "single" || rawMode === "parallel" || rawMode === "chain" ? rawMode : fallbackMode;
  return { mode, tasks };
}

function childStatus(task: ChildTask): "success" | "error" | "running" {
  if (task.error || task.exitCode !== undefined && task.exitCode !== 0) return "error";
  if (task.output || task.exitCode === 0) return "success";
  return "running";
}

function controlTitle(action: string | undefined, status: string, t: Parameters<ActivityRenderer["compact"]>[0]["t"]): string {
  if (action === "list") return t("conversation.activity.subagentControl.list");
  if (action === "status") return t("conversation.activity.subagentControl.status");
  if (action === "stop") return t("conversation.activity.subagentControl.stop");
  if (action === "collect") return t(status === "running" ? "conversation.activity.subagentControl.collecting" : "conversation.activity.subagentControl.collected");
  return t("conversation.activity.subagentControl.default");
}

function delegationState(source: Parameters<ActivityRenderer["compact"]>[0]["source"]): "running" | "done" | "error" {
  const status = text(record(source.details)?.status);
  if (status === "running") return "running";
  if (status === "failed" || status === "cancelled" || status === "timed_out") return "error";
  if (status === "completed") return "done";
  return source.status === "error" ? "error" : source.status === "running" ? "running" : "done";
}

function controlStatus(status: string | undefined, t: Parameters<ActivityRenderer["compact"]>[0]["t"]): string | undefined {
  return ["running", "completed", "failed", "cancelled", "timed_out"].includes(status ?? "")
    ? t(`conversation.activity.subagentControl.status.${status}`)
    : status;
}

export const SubagentActivityRenderer: ActivityRenderer = {
  compact: ({ source, t }) => {
    if (source.tool.trim().toLowerCase() === "subagent_control") {
      const details = record(source.details);
      const status = controlStatus(text(details?.status), t);
      return {
        title: controlTitle(text(source.input?.action), source.status, t),
        ...(status ? { detail: status } : {}),
      };
    }
    const { tasks } = childTasks(source);
    const count = Math.max(tasks.length, 1);
    const failure = toolErrorSummary(source);
    const state = delegationState(source);
    const title = state === "running"
      ? count === 1 && tasks[0]?.agent ? t("conversation.activity.subagentRunningNamed", { agent: tasks[0].agent }) : t("conversation.activity.subagentsRunning", { count })
      : state === "error"
        ? t("conversation.activity.subagentsFailed", { count })
        : count === 1 && tasks[0]?.agent ? t("conversation.activity.subagentCompleteNamed", { agent: tasks[0].agent }) : t("conversation.activity.subagentsComplete", { count });
    if (failure) return { title, detail: failure };
    const succeeded = tasks.filter((task) => childStatus(task) === "success").length;
    const failed = tasks.filter((task) => childStatus(task) === "error").length;
    const detail = state === "running"
      ? t("conversation.activity.subagentProgress", { done: succeeded + failed, count })
      : failed > 0
        ? t("conversation.activity.subagentResultSummary", { succeeded, failed })
        : undefined;
    return { title, ...(detail ? { detail } : {}) };
  },
  expanded: (props) => {
    const { mode, tasks } = childTasks(props.source);
    if (tasks.length === 0) return genericDetails(props);
    const rows: ActivityDetailView[] = [
      { label: props.t("conversation.activity.toolLabel"), value: props.source.tool, plain: true },
      { label: props.t("conversation.activity.delegationMode"), value: props.t(`conversation.activity.delegationMode.${mode}`), plain: true },
    ];
    const taskId = text(record(props.source.details)?.task_id);
    if (taskId) rows.push({ label: props.t("conversation.activity.taskId"), value: taskId, plain: true });
    const failure = toolErrorSummary(props.source);
    if (failure) rows.push({ label: props.t("conversation.activity.errorDetail"), value: failure, fullValue: failure });
    tasks.forEach((task, index) => {
      const status = childStatus(task);
      const parts = [
        task.task,
        props.t(`conversation.activity.subagentStatus.${status}`),
        task.error ?? task.output,
        task.outputTruncated ? props.t("conversation.activity.subagentOutputTruncated") : undefined,
      ].filter((value): value is string => Boolean(value));
      rows.push({
        label: task.agent ?? props.t("conversation.activity.subagentNumber", { number: index + 1 }),
        value: parts.join("\n\n"),
        pre: true,
      });
    });
    return rows;
  },
};
