import type { ToolCallBlock } from "../../../types/thread";
import type { ActivityDetailView, ActivityRendererProps } from "./types";

export function genericDetails({ source, t }: ActivityRendererProps): ActivityDetailView[] {
  const discovery = ["ls", "glob", "grep"].includes(source.tool);
  const details: ActivityDetailView[] = [{ label: t("conversation.activity.toolLabel"), value: source.tool, plain: true }];
  const failure = toolErrorSummary(source);
  if (failure) details.push({ label: t("conversation.activity.errorDetail"), value: failure, fullValue: failure });
  if (source.input) details.push({ label: t("conversation.activity.input"), value: stringify(source.input), pre: true });
  const output = source.output ?? source.partialOutput;
  if (output) details.push({
    label: t("conversation.activity.output"),
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
    const remaining = detailObject ? Object.fromEntries(Object.entries(detailObject).filter(([key]) => key !== "fileChange" && key !== "diff" && key !== "patch")) : source.details;
    const value = stringify(remaining);
    if (value !== "{}") {
      details.push({ label: t("conversation.activity.details"), value, fullValue: value, ...(discovery ? { pre: true } : {}) });
    }
  }
  const patch = change?.patch ?? text(detailObject?.patch) ?? text(detailObject?.diff) ?? source.diff;
  if (patch) details.push({ label: t("conversation.activity.diff"), value: patch, fullValue: patch, pre: true });
  return details;
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

export function meaningfulActivityTitle(title: string, tool: string): string | undefined {
  const value = text(title);
  if (!value) return undefined;
  const normalizedTitle = value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const normalizedTool = tool.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (normalizedTitle === normalizedTool || normalizedTitle === `running ${normalizedTool}`) return undefined;
  return value;
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
