import { count, detailRecord, genericDetails, record, text } from "./shared";
import type { ActivityRenderer } from "./types";

function kernelName(tool: string): string {
  const normalized = tool.trim().toLowerCase();
  if (normalized === "r" || normalized.includes("r_kernel")) return "R";
  if (normalized.includes("python") || normalized.includes("jupyter") || normalized.includes("notebook")) return "Python";
  return "Kernel";
}

export const KernelActivityRenderer: ActivityRenderer = {
  compact: ({ activity, source, t }) => {
    const kernel = kernelName(source.tool);
    const details = detailRecord(source);
    const outputCount = count(details.outputs) ?? count(record(details.result)?.outputs);
    const title = activity.state === "running"
      ? t("conversation.activity.kernelRunning", { kernel })
      : activity.state === "error"
        ? t("conversation.activity.kernelFailed", { kernel })
        : t("conversation.activity.kernelComplete", { kernel });
    return { title, ...(outputCount !== undefined ? { detail: t("conversation.activity.outputCount", { count: outputCount }) } : {}) };
  },
  expanded: (props) => {
    const rows = genericDetails(props);
    const input = props.source.input ?? {};
    const details = detailRecord(props.source);
    const code = text(input.code) ?? text(input.source) ?? text(input.script);
    const stdout = text(details.stdout);
    const stderr = text(details.stderr);
    const environment = text(details.environmentRevision) ?? text(details.environment_revision) ?? text(input.environmentRevision);
    if (code) rows.splice(1, 0, { label: props.t("conversation.activity.code"), value: code, pre: true });
    if (stdout) rows.push({ label: "stdout", value: stdout, fullValue: stdout });
    if (stderr) rows.push({ label: "stderr", value: stderr, fullValue: stderr });
    if (environment) rows.push({ label: props.t("conversation.activity.environmentRevision"), value: environment, plain: true });
    return rows;
  },
};
