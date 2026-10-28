import { z } from "zod";
import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ExecutionBudgetLedger, watchExecutionDeadline, budgetLimitsSchema, executionKinds, MAX_SECONDS, MAX_EXECUTIONS, type ExecutionKind } from "../../executions/execution-budget.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;
export const kindLimitsParameters = Type.Object(Object.fromEntries(executionKinds.map((kind) => [kind, Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_EXECUTIONS }))])));
export const localBudgetParameters = Type.Object({ max_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SECONDS })), max_executions: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EXECUTIONS })), by_kind: Type.Optional(kindLimitsParameters) });
export { watchExecutionDeadline } from "../../executions/execution-budget.js";
export function executionBudgetTools(cwd: string, inheritedOperationId?: string, nodeId?: string) {
  const ledger = (operationId: string) => new ExecutionBudgetLedger(cwd, inheritedOperationId ?? operationId, !!inheritedOperationId, nodeId);
  const valuesSchema = budgetLimitsSchema.extend({ research_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional() }).strict();
  const tool: Tool = {
    name: "execution_budget", label: "Execution budget",
    description: "Inspect or narrow the durable task-tree budget. All descendants share the global cap and deadline; child-local limits also apply. by_kind limits bash, notebook, mcp, subagent or job calls separately. Limits never expand. Bind research_id before spending to share across continuation operations. Counts admissions, not tokens; replay does not spend twice.",
    parameters: Type.Object({ ...localBudgetParameters.properties, research_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" })) }),
    async execute(_id, params, _update, _ctx, invocation) {
      const { research_id, ...limits } = valuesSchema.parse(params);
      const status = await ledger(invocation.operationId).configure(limits, research_id);
      const details = { ...status, remaining_seconds: Math.max(0, Math.floor((status.deadline - Date.now()) / 1000)) };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
  const kindFor = (name: string): ExecutionKind => name.startsWith("mcp__") ? "mcp" : name === "subagent" ? "subagent" : name === "bash" || name === "remote_execute" || name === "slurm_submit" ? "bash" : "notebook";
  const wrap = (original: Tool): Tool => ({ ...original,
    async execute(id, params, update, ctx, invocation, context) {
      const owner = ledger(invocation.operationId);
      const group = params as { tasks?: unknown[]; chain?: unknown[] } | null;
      const units = original.name === "subagent" ? group?.tasks?.length ?? group?.chain?.length ?? 1 : 1;
      const budget = await owner.reserve(kindFor(original.name), invocation.operationId, invocation.invocationId, units);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Execution time budget exhausted")), Math.max(1, Math.min(600_000, budget.deadline - Date.now())));
      const stopWatching = watchExecutionDeadline(owner, (error) => controller.abort(error));
      const abortSignal = context.abortSignal ? AbortSignal.any([context.abortSignal, controller.signal]) : controller.signal;
      try {
        abortSignal.throwIfAborted();
        let boundedParams = params;
        if (original.name === "notebook_run" && params && typeof params === "object") {
          const remainingSeconds = Math.floor((budget.deadline - Date.now()) / 1000);
          if (remainingSeconds < 1) throw new Error("Execution time budget exhausted");
          const values = params as { timeout_seconds?: number };
          boundedParams = { ...values, timeout_seconds: Math.min(600, remainingSeconds, values.timeout_seconds ?? 120) };
        }
        return await original.execute(id, boundedParams, update, ctx, invocation, { ...context, abortSignal });
      } finally { clearTimeout(timeout); await stopWatching(); }
    },
  });
  return { tool, wrap, ledger };
}
