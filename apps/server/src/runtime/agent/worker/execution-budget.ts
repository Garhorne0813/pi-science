import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../../storage/persistence.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;
interface Budget { deadline: number; maxExecutions: number; used: number }
const MAX_SECONDS = 3600;
const MAX_EXECUTIONS = 100;
const budgetSchema = z.object({ deadline: z.number().finite().positive(), maxExecutions: z.number().int().min(1).max(MAX_EXECUTIONS), used: z.number().int().min(0).max(MAX_EXECUTIONS) }).strict();
async function readBudget(path: string): Promise<Budget | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const parsed = budgetSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("Invalid saved execution budget; refusing to reset its limits");
  return parsed.data;
}

/** Generic operation-scoped admission and deadlines, durable across worker recovery. */
export function executionBudgetTools(cwd: string): { tool: Tool; wrap: (tool: Tool) => Tool } {
  const pathFor = (id: string) => workspaceFile(cwd, `execution-budgets/${createHash("sha256").update(id).digest("hex")}.json`);
  const tool: Tool = {
    name: "execution_budget", label: "Execution budget",
    description: "Set or inspect a durable budget for this conversation operation before costly tool calls. Bounds bash, notebook, MCP and subagent executions. Limits may be narrowed but never expanded during an operation. Save remaining research budgets in checkpoints for continuation.",
    parameters: Type.Object({ max_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SECONDS })), max_executions: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EXECUTIONS })) }),
    async execute(_id, params, _update, _ctx, invocation) {
      const values = params as { max_seconds?: number; max_executions?: number };
      const path = pathFor(invocation.operationId);
      return withFileWriteLock(path, async () => {
        const prior = await readBudget(path);
        const proposed = { deadline: Date.now() + Math.min(MAX_SECONDS, Math.max(1, values.max_seconds ?? MAX_SECONDS)) * 1000,
          maxExecutions: Math.min(MAX_EXECUTIONS, Math.max(1, values.max_executions ?? MAX_EXECUTIONS)), used: prior?.used ?? 0 };
        const budget = prior ? { ...prior, deadline: values.max_seconds === undefined ? prior.deadline : Math.min(prior.deadline, proposed.deadline),
          maxExecutions: values.max_executions === undefined ? prior.maxExecutions : Math.min(prior.maxExecutions, proposed.maxExecutions) } : proposed;
        await writeJsonAtomic(path, budget);
        const status = { remaining_seconds: Math.max(0, Math.floor((budget.deadline - Date.now()) / 1000)), remaining_executions: Math.max(0, budget.maxExecutions - budget.used), ...budget };
        return { content: [{ type: "text", text: JSON.stringify(status) }], details: status };
      });
    },
  };
  const wrap = (original: Tool): Tool => ({ ...original,
    async execute(id, params, update, ctx, invocation, context) {
      const path = pathFor(invocation.operationId);
      const budget = await withFileWriteLock(path, async () => {
        const saved = await readBudget(path);
        const value = saved ?? { deadline: Date.now() + MAX_SECONDS * 1000, maxExecutions: MAX_EXECUTIONS, used: 0 };
        if (value.deadline <= Date.now()) throw new Error("Execution time budget exhausted");
        const admitted = await invocation.getMemo("execution-budget-admitted");
        if (!admitted) {
          if (value.used >= value.maxExecutions) throw new Error("Execution call budget exhausted");
          value.used++;
          // A crash between reservation and memo is conservative: it may consume an extra slot, never exceed the cap.
          await writeJsonAtomic(path, value);
          await invocation.setMemo("execution-budget-admitted", true);
        }
        return value;
      });
      // Each tool has a hard ceiling even without an explicit task budget. An
      // expired budget aborts the existing tool's signal (including child cancellation).
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Execution time budget exhausted")), Math.max(1, Math.min(600_000, budget.deadline - Date.now())));
      const abortSignal = context.abortSignal ? AbortSignal.any([context.abortSignal, controller.signal]) : controller.signal;
      try {
        let boundedParams = params;
        if (original.name === "notebook_run" && params && typeof params === "object") {
          const remainingSeconds = Math.floor((budget.deadline - Date.now()) / 1000);
          if (remainingSeconds < 1) throw new Error("Execution time budget exhausted");
          const values = params as { timeout_seconds?: number };
          boundedParams = { ...values, timeout_seconds: Math.min(600, remainingSeconds, values.timeout_seconds ?? 120) };
        }
        return await original.execute(id, boundedParams, update, ctx, invocation, { ...context, abortSignal });
      }
      finally { clearTimeout(timeout); }
    },
  });
  return { tool, wrap };
}
