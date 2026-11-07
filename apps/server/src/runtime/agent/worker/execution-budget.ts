import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  ExecutionBudgetLedger,
  watchExecutionDeadline,
  type ExecutionKind,
} from "../../executions/execution-budget.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;
export { watchExecutionDeadline } from "../../executions/execution-budget.js";
export function executionBudgetTools(cwd: string, inheritedOperationId?: string, nodeId?: string) {
  const ledger = (operationId: string) =>
    new ExecutionBudgetLedger(
      cwd,
      inheritedOperationId ?? operationId,
      !!inheritedOperationId,
      nodeId,
    );
  const kindFor = (name: string): ExecutionKind =>
    name.startsWith("mcp__")
      ? "mcp"
      : name === "subagent"
        ? "subagent"
        : name === "bash"
          ? "bash"
          : "notebook";
  const wrap = (original: Tool): Tool => ({
    ...original,
    async execute(id, params, update, ctx, invocation, context) {
      const owner = ledger(invocation.operationId);
      const group = params as { tasks?: unknown[]; chain?: unknown[] } | null;
      const units =
        original.name === "subagent" ? (group?.tasks?.length ?? group?.chain?.length ?? 1) : 1;
      const budget = await owner.reserve(
        kindFor(original.name),
        invocation.operationId,
        invocation.invocationId,
        units,
      );
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Execution time budget exhausted")),
        Math.max(1, Math.min(600_000, budget.deadline - Date.now())),
      );
      const stopWatching = watchExecutionDeadline(owner, (error) => controller.abort(error));
      const abortSignal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, controller.signal])
        : controller.signal;
      try {
        abortSignal.throwIfAborted();
        let boundedParams = params;
        if (original.name === "notebook_run" && params && typeof params === "object") {
          const remainingSeconds = Math.floor((budget.deadline - Date.now()) / 1000);
          if (remainingSeconds < 1) throw new Error("Execution time budget exhausted");
          const values = params as { timeout_seconds?: number };
          boundedParams = {
            ...values,
            timeout_seconds: Math.min(600, remainingSeconds, values.timeout_seconds ?? 120),
          };
        }
        return await original.execute(id, boundedParams, update, ctx, invocation, {
          ...context,
          abortSignal,
        });
      } finally {
        clearTimeout(timeout);
        await stopWatching();
      }
    },
  });
  return { wrap, ledger };
}
