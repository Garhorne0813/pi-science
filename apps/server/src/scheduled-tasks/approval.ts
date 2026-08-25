// Approval scope hashing for recurring scheduled-task approvals (docs §9.3–§9.4).
// The hash covers only the sensitive content of a task (executor config + output
// root) so users re-approve exactly what changes; name, schedule, timezone,
// lifecycle and next_run_at are deliberately excluded because frequency and cost
// are governed by interval/budget/task limits, not by content approval.
import { createHash } from "node:crypto";
import type { ScheduledTaskExecutor } from "@pi-science/contracts";

/**
 * Canonical JSON in fixed key order:
 * {"executor_kind","query","providers"(sorted, deduped),"instructions",
 *  "max_results","language","output_relative_root"}
 * Missing instructions normalize to "" so optional-field presence cannot split
 * one logical scope into two hashes.
 */
export function approvalScopeHashPayload(executor: ScheduledTaskExecutor, outputRelativeRoot: string): string {
  const config = executor.config;
  return JSON.stringify({
    executor_kind: executor.kind,
    query: config.query,
    providers: [...new Set(config.providers)].sort(),
    instructions: config.instructions ?? "",
    max_results: config.max_results,
    language: config.language,
    output_relative_root: outputRelativeRoot,
  });
}

export function computeApprovalScopeHash(executor: ScheduledTaskExecutor, outputRelativeRoot: string): string {
  return createHash("sha256").update(approvalScopeHashPayload(executor, outputRelativeRoot)).digest("hex");
}

/** Exact coverage: every freshly detected sensitive category must be pre-approved (docs §9.3). */
export function approvalCoversCategories(approvalCategories: readonly string[], detectedCategories: readonly string[]): boolean {
  const approved = new Set(approvalCategories);
  return detectedCategories.every((category) => approved.has(category));
}
