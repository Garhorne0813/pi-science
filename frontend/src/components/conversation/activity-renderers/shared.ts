import type { ToolCallBlock } from "../../../types/thread";
import type { ActivityDetailView, ActivityRendererProps } from "./types";

export function genericDetails({ source, t }: ActivityRendererProps): ActivityDetailView[] {
  const details: ActivityDetailView[] = [{ label: t("conversation.activity.toolLabel"), value: source.tool, plain: true }];
  if (source.input) details.push({ label: t("conversation.activity.input"), value: stringify(source.input), pre: true });
  const output = source.output ?? source.partialOutput;
  if (output) details.push({
    label: t("conversation.activity.output"),
    value: output,
    ...(source.output ? { fullValue: source.output } : {}),
    partial: Boolean(source.partialOutput && !source.output),
  });
  if (source.details !== undefined && source.details !== null) {
    const value = stringify(source.details);
    details.push({ label: t("conversation.activity.details"), value, fullValue: value });
  }
  if (source.diff) details.push({ label: t("conversation.activity.diff"), value: source.diff, fullValue: source.diff });
  return details;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function meaningfulActivityTitle(title: string, tool: string): string | undefined {
  const value = text(title);
  if (!value || value.toLowerCase() === tool.trim().toLowerCase()) return undefined;
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
