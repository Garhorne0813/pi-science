import { branchTip, setValue, type AgentHarnessTool, type NodeExecutionEnv, type Session, type Value } from "@earendil-works/pi-agent-core/node";
import { boundedToolDetails } from "../../node/message-details.js";
import { EMPTY_STATE, type TaskState } from "./todo-domain/state/state.js";
import { applyTaskMutation } from "./todo-domain/state/state-reducer.js";
import { buildToolResult } from "./todo-domain/tool/response-envelope.js";
import { TodoParamsSchema, type TodoParams } from "./todo-domain/tool/types.js";
import { z } from "zod";

type Result = ReturnType<typeof buildToolResult>;
const address = <T>(key: string): Value<T> => ({ kind: "value", namespace: "pi-science", key });
const stateSchema = z.object({ nextId: z.number().int().positive(), tasks: z.array(z.object({
  id: z.number().int().positive(), subject: z.string(), status: z.enum(["pending", "in_progress", "completed", "deleted"]),
  description: z.string().optional(), activeForm: z.string().optional(), blockedBy: z.array(z.number().int().positive()).optional(),
  owner: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough()) });

function snapshot(value: unknown): TaskState | undefined {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const state = parsed.data;
  const ids = new Set<number>();
  for (const task of state.tasks) {
    if (!task || !Number.isSafeInteger(task.id) || task.id < 1 || task.id >= state.nextId || ids.has(task.id)
      || typeof task.subject !== "string" || !["pending", "in_progress", "completed", "deleted"].includes(task.status)) return undefined;
    ids.add(task.id);
  }
  return { tasks: state.tasks, nextId: state.nextId };
}

/** Serialize concurrent calls and commit state with a replay receipt in one transaction. */
export function todoHarnessTool(session: Session, branch = "main"): AgentHarnessTool<{ env: NodeExecutionEnv }> {
  return {
    name: "todo", label: "Todo", description: "Manage tasks for multi-step work. Keep one task in progress and mark it completed after verification. Every response includes the complete task snapshot.",
    parameters: TodoParamsSchema,
    async execute(_id, raw, _update, _toolContext, invocation, context) {
      const params = raw as TodoParams;
      return session.mutate(async (mutator, mutationContext) => {
        const receipt = address<Result>(`todo-result/${invocation.operationId}/${invocation.invocationId}`);
        const previous = await mutator.getValue(receipt, mutationContext);
        if (previous) return previous.value;
        const stateAddress = address<{ operationId: string; state: TaskState }>(`todo-state/${branch}`);
        const saved = (await mutator.getValue(stateAddress, mutationContext))?.value;
        let state: TaskState = EMPTY_STATE;
        if (saved?.operationId === invocation.operationId) state = saved.state;
        else {
          const tip = (await mutator.getValue(branchTip(branch), mutationContext))?.value;
          if (tip) {
            for (const entry of await mutator.scanBranch({ start: tip, order: "newestFirst", type: "message" }, mutationContext)) {
              if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") continue;
              const recovered = snapshot(entry.message.details);
              if (recovered) { state = recovered; break; }
            }
          }
        }
        let applied = applyTaskMutation(state, params.action, params);
        let result = buildToolResult(params.action, params, applied.state, applied.op);
        if (boundedToolDetails(result.details) === undefined) {
          applied = { state, op: { kind: "error", message: "Task snapshot exceeds the history size limit" } };
          result = buildToolResult(params.action, {}, state, applied.op);
        }
        await mutator.commit([setValue(stateAddress, { operationId: invocation.operationId, state: applied.state }), setValue(receipt, result)], mutationContext);
        return result;
      }, context);
    },
  };
}
