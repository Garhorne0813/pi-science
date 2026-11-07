import { genericDetails, record, text } from "./shared";
import type { ActivityDetailView, ActivityRendererProps } from "./types";

const READ_TOOLS = new Set(["read", "read_file"]);
const EDIT_TOOLS = new Set(["edit", "write", "write_file", "apply_patch"]);

export function toolDetails(props: ActivityRendererProps): ActivityDetailView[] {
  const { source, t } = props;
  const tool = source.tool.trim().toLowerCase();
  if (tool === "bash") {
    const { command, ...input } = source.input ?? {};
    const { exit_code, exitCode, ...details } = record(source.details) ?? {};
    const code = exit_code ?? exitCode;
    const rows: ActivityDetailView[] = [];
    if (typeof command === "string" && command.trim()) {
      rows.push({ label: t("conversation.activity.command"), value: command, fullValue: command });
    } else if (command !== undefined) {
      input.command = command;
    }
    if (typeof code === "number") {
      rows.push({ label: t("conversation.activity.exitCode"), value: String(code), plain: true });
    }
    return [...rows, ...genericDetails({ ...props, source: {
      ...source,
      input: Object.keys(input).length ? input : undefined,
      details: typeof code === "number" ? nonempty(details) : source.details,
    } })];
  }

  if (!READ_TOOLS.has(tool) && !EDIT_TOOLS.has(tool)) return genericDetails(props);
  const { path, file_path, ...input } = source.input ?? {};
  const file = text(path) ?? text(file_path);
  const details = record(source.details);
  const editDiff = EDIT_TOOLS.has(tool) ? source.diff ?? text(details?.diff) : undefined;
  const remainingDetails = editDiff && details
    ? Object.fromEntries(Object.entries(details).filter(([key, value]) => key !== "diff" || value !== editDiff))
    : details;
  const rows = genericDetails({ ...props, source: {
    ...source,
    input: file ? nonempty(input) : source.input,
    diff: editDiff ? undefined : source.diff,
    details: remainingDetails ? nonempty(remainingDetails) : source.details,
  } }, READ_TOOLS.has(tool) && source.status !== "error" ? t("conversation.activity.fileContents") : undefined);
  if (file) rows.unshift({ label: t("conversation.activity.filePath"), value: file, plain: true });
  if (editDiff) rows.splice(file ? 1 : 0, 0, { label: t("conversation.activity.diff"), value: editDiff, fullValue: editDiff, diff: true });
  return rows;
}

function nonempty(input: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(input).length ? input : undefined;
}
