import { activityToolName } from "../../../lib/conversation/activity-presenters";
import { isMcpToolName } from "@pi-science/contracts";
import type { ToolCallBlock } from "../../../types/thread";
import type { ActivityDetailView, ActivityRendererProps } from "./types";

export function genericDetails({ source, t }: ActivityRendererProps, outputLabel = t("conversation.activity.output")): ActivityDetailView[] {
  const discovery = ["ls", "glob", "grep"].includes(activityToolName(source.tool));
  const details: ActivityDetailView[] = [{ label: t("conversation.activity.toolLabel"), value: source.tool, plain: true }];
  const failure = toolErrorSummary(source);
  if (failure) details.push({ label: t("conversation.activity.errorDetail"), value: failure, fullValue: failure });
  details.push(...toolInputDetails(source, t));
  const output = source.output ?? source.partialOutput;
  if (output) details.push({
    label: outputLabel,
    value: output,
    ...(discovery ? { pre: true } : {}),
    ...(source.output ? { fullValue: source.output } : {}),
    partial: Boolean(source.partialOutput && !source.output),
    transportTruncated: source.outputTruncated === true,
    ...(source.originalOutputBytes !== undefined ? { originalBytes: source.originalOutputBytes } : {}),
  });
  const detailObject = record(source.details);
  const change = fileChange(source);
  if (source.details !== undefined && source.details !== null) {
    const consumed = new Set(["fileChange", "diff", "patch"]);
    if (source.presentation?.kind === "verify" || ["bash", "shell", "exec", "execute", "test", "vitest", "pytest", "jest", "typecheck", "lint", "build", "compile", "check"].includes(source.tool.trim().toLowerCase())) {
      for (const key of ["execution", "verification", "tests", "exitCode", "exit_code", "executionId", "execution_id"]) consumed.add(key);
    }
    if (source.tool.trim().toLowerCase() === "subagent_control") {
      for (const key of ["status", "task_id"]) consumed.add(key);
    }
    const remaining = detailObject ? Object.fromEntries(Object.entries(detailObject).filter(([key]) => !consumed.has(key))) : source.details;
    const value = stringify(remaining);
    if (value !== "{}") {
      details.push({ label: t("conversation.activity.details"), value, fullValue: value, ...(discovery ? { pre: true } : {}) });
    }
  }
  const patch = change?.patch ?? text(detailObject?.patch) ?? text(detailObject?.diff) ?? source.diff;
  if (patch) details.push({ label: t("conversation.activity.diff"), value: patch, fullValue: patch, pre: true });
  return details;
}

/** Present stable, human-readable inputs for built-in tools. Descriptions are
 * already used as activity titles, so repeating them in an input JSON blob
 * adds noise. Unknown tools retain a filtered JSON fallback. */
export function toolInputDetails(source: ToolCallBlock, t: ActivityRendererProps["t"]): ActivityDetailView[] {
  const input = source.input;
  if (!input) return [];
  // MCP names may contain a built-in tool's name; only the server-provided
  // presentation may lend them built-in semantics.
  if (isMcpToolName(source.tool)) {
    const filtered = Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== "description" && value !== undefined));
    if (Object.keys(filtered).length === 0) return [];
    return [{ label: t("conversation.activity.input"), value: stringify(filtered), pre: true }];
  }
  const tool = source.tool.trim().toLowerCase();
  const rows: ActivityDetailView[] = [];
  const add = (label: string, value: unknown, pre = false) => {
    const rendered = text(value);
    if (rendered) rows.push({ label, value: rendered, ...(pre ? { pre: true } : { plain: true }) });
  };

  if (["bash", "shell", "exec", "execute"].includes(tool)) {
    add(t("conversation.activity.command"), input.command, true);
    return rows;
  }

  if (tool.includes("python") || tool.includes("kernel") || ["r", "notebook", "notebook_run", "run_cell", "execute_code", "run_code"].includes(tool)) {
    add(t("conversation.activity.code"), input.code ?? input.source ?? input.script, true);
    return rows;
  }

  if (tool === "subagent_control") {
    add(t("conversation.activity.action"), input.action);
    add(t("conversation.activity.taskId"), input.task_id);
    return rows;
  }

  if (tool === "subagent" || tool.includes("subagent")) return rows;

  const path = input.path ?? input.file_path ?? input.file ?? input.directory ?? input.target;
  const query = input.query ?? input.pattern;
  if (tool === "ls" || /read|write|edit|patch|file|grep|glob|find|list/.test(tool)) {
    add(t("conversation.activity.path"), path);
    add(t(input.pattern !== undefined ? "conversation.activity.pattern" : "conversation.activity.query"), query);
    add(t("conversation.activity.diff"), input.patch ?? input.diff, true);
    if (rows.length > 0) return rows;
  }

  if (/search|fetch|literature|pubmed|arxiv|crossref/.test(tool)) {
    add(t("conversation.activity.query"), query);
    add(t("conversation.activity.url"), input.url);
    add(t("conversation.activity.source"), input.database ?? input.source ?? input.provider ?? input.server);
    if (rows.length > 0) return rows;
  }

  const filtered = Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== "description" && value !== undefined));
  if (Object.keys(filtered).length === 0) return [];
  return [{ label: t("conversation.activity.input"), value: stringify(filtered), pre: true }];
}

export interface FileChangeView {
  path: string;
  additions: number;
  deletions: number;
  patch?: string;
  truncated?: boolean;
}

export function fileChange(source: ToolCallBlock): FileChangeView | null {
  const value = record(record(source.details)?.fileChange);
  if (!value || typeof value.path !== "string") return null;
  const additions = typeof value.additions === "number" && Number.isFinite(value.additions) && value.additions >= 0 ? Math.round(value.additions) : null;
  const deletions = typeof value.deletions === "number" && Number.isFinite(value.deletions) && value.deletions >= 0 ? Math.round(value.deletions) : null;
  if (additions === null || deletions === null) return null;
  return {
    path: value.path,
    additions,
    deletions,
    ...(typeof value.patch === "string" ? { patch: value.patch } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
  };
}

export function toolFilePath(source: ToolCallBlock): string | undefined {
  return fileChange(source)?.path
    ?? text(source.input?.path)
    ?? text(source.input?.file_path)
    ?? text(source.input?.file)
    ?? text(source.input?.target);
}

/** Pull one actionable error line out of the result envelope. The complete
 * output remains available below; this is deliberately a summary, not a
 * replacement for logs. */
export function toolErrorSummary(source: ToolCallBlock): string | undefined {
  // A recovered call keeps its failed attempt in statusHistory, but its final
  // output is no longer an error. Retry history is presented separately.
  if (source.status !== "error") return undefined;
  const details = record(source.details);
  const nested = record(details?.result);
  for (const value of [details?.error, details?.message, nested?.error, nested?.message]) {
    const summary = errorLine(value);
    if (summary) return summary;
  }
  const output = source.output ?? source.partialOutput;
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    const envelope = record(parsed);
    for (const value of [envelope?.error, envelope?.message, record(envelope?.details)?.error]) {
      const summary = errorLine(value);
      if (summary) return summary;
    }
  } catch { /* ordinary stderr/stdout */ }
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return errorLine(lines.find((line) => /(?:error|failed|exception|traceback)/i.test(line)) ?? lines.at(-1));
}

function errorLine(value: unknown): string | undefined {
  const line = text(value)?.split("\n").find((candidate) => candidate.trim())?.trim();
  if (!line) return undefined;
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function count(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

export function detailRecord(source: ToolCallBlock): Record<string, unknown> {
  return record(source.details) ?? {};
}
