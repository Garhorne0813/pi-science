import { resolveAgentCompaction, type PiConfig } from "@pi-science/contracts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, estimateContextTokens, getLastAssistantUsage, type AgentMessage, type CompactionSettings, type Entry, type Value } from "@earendil-works/pi-agent-core";

export type RuntimeSettings = Pick<PiConfig, "compaction_enabled" | "compaction_threshold_percent" | "model_context_window_override">;
export type AppliedRuntimeSettings = {
  model: string;
  contextWindow: number;
  compaction: CompactionSettings;
  thresholdPercent: number;
};
export const appliedRuntimeSettings: Value<AppliedRuntimeSettings> = {
  kind: "value", namespace: "pi-science", key: "runtime-settings",
};

export function resolveContextWindow(model: string, window: number, settings: RuntimeSettings): number {
  const override = settings.model_context_window_override;
  return override?.model === model ? override.context_window : window;
}

/** Shared with Settings: the default shown by the UI is also applied to Harness. */
export function resolveCompaction(window: number, settings: RuntimeSettings = {}): { compaction: CompactionSettings; thresholdPercent: number } {
  const { thresholdPercent, compaction } = resolveAgentCompaction(window, settings);
  return { thresholdPercent, compaction };
}

export async function contextUsage(entries: Entry[], window: number | null) {
  const lastCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
  // Usage retained inside a summary refers to the old, larger request. Wait
  // for a measurement in the new context instead of displaying that value.
  const measured = getLastAssistantUsage(entries.slice(lastCompaction + 1));
  // Core's context builder is private. Use its public summary constructors to
  // project the entry kinds this runtime supplies; exclude compacted ancestors.
  const messages: AgentMessage[] = [];
  for (const entry of entries.slice(Math.max(0, lastCompaction))) {
    if (entry.type === "message") messages.push(entry.message);
    else if (entry.type === "compaction") messages.push(createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp), ...entry.retainedTail);
    else if (entry.type === "branch_summary" && entry.summary) messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
  }
  const valid = messages.filter((message) => message.role !== "assistant" || !["error", "aborted", "deferred"].includes(message.stopReason));
  const tokens = measured ? estimateContextTokens(valid).tokens : null;
  return { context_tokens: tokens, context_window: window,
    context_percent: tokens !== null && window ? tokens / window * 100 : null };
}
