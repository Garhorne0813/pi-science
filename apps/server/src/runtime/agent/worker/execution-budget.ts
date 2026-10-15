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
export function executionBudgetTools(cwd: string, inheritedOperationId?: string): { tool: Tool; wrap: (tool: Tool) => Tool } {
  const pathFor = (id: string) => workspaceFile(cwd, `execution-budgets/${createHash("sha256").update(id).digest("hex")}.json`);
  const hash = (id: string) => createHash("sha256").update(id).digest("hex");
  const scopePath = (id: string) => workspaceFile(cwd, `execution-budget-scopes/${hash(id)}.json`);
  const valuesSchema = z.object({ research_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),
    max_seconds: z.number().int().min(1).max(MAX_SECONDS).optional(), max_executions: z.number().int().min(1).max(MAX_EXECUTIONS).optional() }).strict();
  const resolvePath = async (operationId: string, values?: z.infer<typeof valuesSchema>): Promise<string> => {
    const owner = inheritedOperationId ?? operationId;
    const bindingPath = scopePath(owner);
    return withFileWriteLock(bindingPath, async () => {
      let binding: { researchId: string } | null = null;
      try { binding = z.object({ researchId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) }).strict().parse(JSON.parse(await readFile(bindingPath, "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid execution budget scope; refusing to reset"); }
      if (values?.research_id && inheritedOperationId) throw new Error("Children cannot change the shared budget scope");
      if (values?.research_id && binding && binding.researchId !== values.research_id) throw new Error("Cannot change an operation's budget scope");
      if (values?.research_id && !binding) {
        if (await readBudget(pathFor(owner))) throw new Error("Bind research_id before the first execution or operation budget");
        const researchPath = pathFor(`research:${values.research_id}`);
        // Write limits before publishing the binding; recovery can only reuse or narrow them.
        await withFileWriteLock(researchPath, async () => {
          if (!await readBudget(researchPath)) await writeJsonAtomic(researchPath, { deadline: Date.now() + (values.max_seconds ?? MAX_SECONDS) * 1000,
            maxExecutions: values.max_executions ?? MAX_EXECUTIONS, used: 0 });
        });
        binding = { researchId: values.research_id };
        await writeJsonAtomic(bindingPath, binding);
      }
      const target = binding ? pathFor(`research:${binding.researchId}`) : pathFor(owner);
      if (binding && !await readBudget(target)) throw new Error("Missing shared execution budget; refusing to reset");
      if (!binding && !inheritedOperationId) await withFileWriteLock(target, async () => {
        if (!await readBudget(target)) await writeJsonAtomic(target, { deadline: Date.now() + (values?.max_seconds ?? MAX_SECONDS) * 1000,
          maxExecutions: values?.max_executions ?? MAX_EXECUTIONS, used: 0 });
      });
      return target;
    });
  };
  const tool: Tool = {
    name: "execution_budget", label: "Execution budget",
    description: "Set or inspect a durable budget for this conversation operation before costly tool calls. Bounds bash, notebook, MCP and subagent executions. Limits may be narrowed but never expanded during an operation. Set research_id before the first execution to share one persistent budget across continuation operations. Hidden children inherit the same cap. Counts calls, not semantic experiments, tokens or cost.",
    parameters: Type.Object({ research_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" })), max_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SECONDS })), max_executions: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EXECUTIONS })) }),
    async execute(_id, params, _update, _ctx, invocation) {
      const values = valuesSchema.parse(params);
      const path = await resolvePath(invocation.operationId, values);
      return withFileWriteLock(path, async () => {
        const prior = await readBudget(path);
        if (!prior && inheritedOperationId) throw new Error("Missing inherited execution budget; refusing to reset");
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
      const path = await resolvePath(invocation.operationId);
      const budget = await withFileWriteLock(path, async () => {
        const saved = await readBudget(path);
        if (!saved && inheritedOperationId) throw new Error("Missing inherited execution budget; refusing to reset");
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
