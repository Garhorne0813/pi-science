import type { ScheduledTask } from "@pi-science/contracts";
import { piManager } from "../runtime/pi/pi-manager.js";
import { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import { HeadlessAgentExecutor, type HeadlessAgentManager } from "./headless-agent-runner.js";

/** An executor performs one scheduled-task run. The coordinator injects the
 *  executor map and dispatches by `task.executor.kind`; a missing executor is
 *  a non-retryable run failure. */
export interface ScheduledTaskExecutor {
  run(
    task: ScheduledTask,
    runId: string,
    ctx: { cwd: string; log: (line: string) => Promise<void> },
  ): Promise<{ output_paths: string[]; usage: { model_tokens: number; cost_usd: number } }>;
}

export type ExecutorKind = "headless_agent";

export const executorKinds: readonly ExecutorKind[] = ["headless_agent"];

/** Shared registry: the headless-agent runner registers itself here; the
 *  coordinator defaults its injected executor map to this registry. The
 *  default instance uses the shared PiManager and a bare environment service;
 *  app wiring injects workspace-scoped services via buildDefaultExecutors. */
export const registry: Record<ExecutorKind, ScheduledTaskExecutor> = {
  headless_agent: new HeadlessAgentExecutor({ environments: new WorkspaceEnvironmentService() }),
};

/** Factory for the app-owned executor set, bound to the app's PiManager and
 *  workspace environment service so a scheduled agent shares the same
 *  manager/credentials as the rest of the control plane. */
export function buildDefaultExecutors(
  environments: Pick<WorkspaceEnvironmentService, "environment">,
  manager: HeadlessAgentManager = piManager,
): Record<ExecutorKind, ScheduledTaskExecutor> {
  return { headless_agent: new HeadlessAgentExecutor({ environments, manager }) };
}
