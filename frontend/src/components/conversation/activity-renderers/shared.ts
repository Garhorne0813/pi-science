import { activityToolName } from "../../../lib/conversation/activity-presenters";
import type { ToolCallBlock } from "../../../types/thread";
import type { ActivityDetailView, ActivityRendererProps } from "./types";

export function genericDetails({ source, t }: ActivityRendererProps, outputLabel = t("conversation.activity.output")): ActivityDetailView[] {
  const discovery = ["ls", "glob", "grep"].includes(activityToolName(source.tool));
  const details: ActivityDetailView[] = [{ label: t("conversation.activity.toolLabel"), value: source.tool, plain: true }];
  if (source.input) details.push({ label: t("conversation.activity.input"), value: stringify(source.input), pre: true });
  const output = source.output ?? source.partialOutput;
  if (output) details.push({
    label: outputLabel,
    value: output,
    ...(discovery ? { pre: true } : {}),
    ...(source.output ? { fullValue: source.output } : {}),
    partial: Boolean(source.partialOutput && !source.output),
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
