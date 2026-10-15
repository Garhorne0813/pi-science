import type { ExecutionRecord } from "@pi-science/contracts";

export function executionLabel(run: ExecutionRecord): string {
  if (run.kind === "kernel_cell") {
    const notebook = typeof run.request.notebook_id === "string" ? run.request.notebook_id : "default";
    const code = typeof run.request.code === "string" ? run.request.code.trim().split("\n")[0] : "";
    return `${notebook} · ${code || run.surface}`;
  }
  return run.request.command?.join(" ") || String(run.request.tool || run.execution_id);
}

/** Bound display text, including tooltips and accessible names; raw evidence stays intact. */
export function executionPreview(text: string, limit = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  const prefix = compact.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "");
  return `${prefix}…`;
}

/** Prefer recorded descriptions or code excerpts; never invent a research stage. */
export function executionShortLabel(run: ExecutionRecord): string {
  if (typeof run.request.title === "string" && run.request.title.trim()) return executionPreview(run.request.title);
  if (run.kind === "kernel_cell" && run.request.code?.trim()) return executionPreview(run.request.code.trim().split("\n")[0]!);
  const input = run.request.input;
  if (run.request.tool && input && typeof input === "object" && !Array.isArray(input)) {
    const path = (input as Record<string, unknown>).path;
    if (typeof path === "string" && path) return executionPreview(`${run.request.tool} · ${fileName(path)}`);
  }
  return executionPreview(executionLabel(run));
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
  return end >= start ? formatDuration(end - start) : "—";
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  if (milliseconds >= 86_400_000) return `${Math.floor(milliseconds / 86_400_000)}d ${Math.floor((milliseconds % 86_400_000) / 3_600_000)}h`;
  if (milliseconds >= 3_600_000) return `${Math.floor(milliseconds / 3_600_000)}h ${Math.floor((milliseconds % 3_600_000) / 60_000)}m`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

export function formatTimestamp(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
