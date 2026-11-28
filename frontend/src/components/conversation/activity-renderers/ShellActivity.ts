import { meaningfulActivityTitle, presentFailedToolActivity, presentToolActivity } from "../../../lib/conversation/activity-presenters";
import { count, detailRecord, genericDetails, record, text, toolErrorSummary } from "./shared";
import type { ActivityDetailView, ActivityRenderer } from "./types";

const TEST_TOOLS = new Set(["test", "vitest", "pytest", "jest", "typecheck", "lint", "build", "compile", "check"]);

function isVerification(tool: string, kind: string | undefined): boolean {
  return kind === "verify" || TEST_TOOLS.has(tool.trim().toLowerCase());
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shellMetadata(source: Parameters<ActivityRenderer["compact"]>[0]["source"]) {
  const details = detailRecord(source);
  const execution = record(details.execution) ?? record(details.result);
  const verification = record(details.verification) ?? record(details.tests) ?? details;
  return {
    exitCode: finiteNumber(details.exitCode) ?? finiteNumber(details.exit_code) ?? finiteNumber(execution?.exitCode) ?? finiteNumber(execution?.exit_code),
    executionId: text(details.executionId) ?? text(details.execution_id) ?? text(execution?.id) ?? text(execution?.execution_id),
    passed: count(verification.passed),
    failed: count(verification.failed),
    skipped: count(verification.skipped),
  };
}

export const ShellActivityRenderer: ActivityRenderer = {
  compact: ({ source, t }) => {
    const verification = isVerification(source.tool, source.presentation?.kind);
    const presentedTitle = presentToolActivity(source, t);
    const semanticTitle = meaningfulActivityTitle(presentedTitle, source.tool);
    const title = source.status === "error"
      ? presentFailedToolActivity(source, t)
      : semanticTitle ?? (verification
        ? source.status === "running" ? t("conversation.activity.testsRunning") : t("conversation.activity.testsPassed")
        : presentedTitle);
    const failure = toolErrorSummary(source);
    if (failure) return { title, detail: failure };

    const metadata = shellMetadata(source);
    const detail: string[] = [];
    if (verification && semanticTitle) detail.push(source.status === "running" ? t("conversation.activity.testsRunning") : t("conversation.activity.testsPassed"));
    if (metadata.passed !== undefined) detail.push(t("conversation.activity.testsPassedCount", { count: metadata.passed }));
    if (metadata.failed !== undefined && metadata.failed > 0) detail.push(t("conversation.activity.testsFailedCount", { count: metadata.failed }));
    if (metadata.skipped !== undefined && metadata.skipped > 0) detail.push(t("conversation.activity.testsSkippedCount", { count: metadata.skipped }));
    if (metadata.exitCode !== undefined) detail.push(t("conversation.activity.exitCode", { code: metadata.exitCode }));
    return { title, ...(detail.length > 0 ? { detail: detail.join(" · ") } : {}) };
  },
  expanded: (props) => {
    const rows = genericDetails(props);
    const metadata = shellMetadata(props.source);
    const resultRows: ActivityDetailView[] = [];
    if (metadata.exitCode !== undefined) resultRows.push({ label: props.t("conversation.activity.exitCodeLabel"), value: String(metadata.exitCode), plain: true });
    if (metadata.executionId) resultRows.push({ label: props.t("conversation.activity.executionId"), value: metadata.executionId, plain: true });
    const counts = [
      metadata.passed !== undefined ? props.t("conversation.activity.testsPassedCount", { count: metadata.passed }) : null,
      metadata.failed !== undefined ? props.t("conversation.activity.testsFailedCount", { count: metadata.failed }) : null,
      metadata.skipped !== undefined ? props.t("conversation.activity.testsSkippedCount", { count: metadata.skipped }) : null,
    ].filter((value): value is string => value !== null);
    if (counts.length > 0) resultRows.push({ label: props.t("conversation.activity.testResults"), value: counts.join(" · "), plain: true });
    rows.splice(1, 0, ...resultRows);
    return rows;
  },
};
