import type { ExecutionRecord } from "@pi-science/contracts";

export function executionLabel(run: ExecutionRecord): string {
  if (run.kind === "kernel_cell") {
    const notebook = typeof run.request.notebook_id === "string" ? run.request.notebook_id : "default";
    const code = typeof run.request.code === "string" ? run.request.code.trim().split("\n")[0] : "";
    return `${notebook} · ${code || run.surface}`;
  }
  if (run.kind === "scheduled_task") {
    // The ledger correlation carries ids only — show task id + attempt id.
    const taskId = typeof run.correlation.scheduled_task_id === "string" ? run.correlation.scheduled_task_id : "";
    const attemptId = typeof run.correlation.scheduled_task_attempt_id === "string" ? run.correlation.scheduled_task_attempt_id : "";
    return [taskId ? `stask:${taskId}` : "", attemptId].filter(Boolean).join(" · ") || run.execution_id;
  }
  return run.request.command?.join(" ") || String(run.request.tool || run.execution_id);
}

export function executionSearchText(run: ExecutionRecord): string {
  return [run.execution_id, run.kind, run.surface, run.status, run.producer, executionLabel(run), ...run.files.read.map((file) => file.path), ...run.files.written.map((file) => file.path)].join("\n");
}

export function outputCount(run: ExecutionRecord): number {
  return Math.max(run.files.written.length, run.artifacts.filter((artifact) => artifact.relation === "output").length);
}

export function isActiveExecution(run: ExecutionRecord): boolean {
  return run.status === "pending" || run.status === "running";
}

export function isProblemExecution(run: ExecutionRecord): boolean {
  return !["pending", "running", "succeeded"].includes(run.status);
}

export function executionCommandText(run: ExecutionRecord): string {
  return run.request.command?.join(" ") || String(run.request.tool || "");
}

export function executionError(run: ExecutionRecord): string {
  return String(run.result.error || run.result.stderr_preview || "").trim();
}

export function workspaceRelativePath(path: string, cwd: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const workspace = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized.startsWith("/")) return normalized.replace(/^\.\//, "");
  return normalized.startsWith(`${workspace}/`) ? normalized.slice(workspace.length + 1) : null;
}

export function fileName(path: string): string {
  return path.split("/").pop() || path;
}

export function executionDuration(run: ExecutionRecord, runningLabel: string): string {
  if (!run.ended_at && ["pending", "running"].includes(run.status)) return runningLabel;
  const start = Date.parse(run.started_at ?? run.created_at);
  const end = run.ended_at ? Date.parse(run.ended_at) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const milliseconds = Math.max(0, end - start);
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function formatTimestamp(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
