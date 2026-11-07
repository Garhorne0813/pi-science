import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { RuntimeEvent, RuntimeResult } from "../agent-runtime-types.js";

export class SubagentBridge {
  private readonly pending = new Map<
    string,
    { resolve: (result: RuntimeResult) => void; cleanup: () => void }
  >();
  constructor(private readonly publish: (event: RuntimeEvent) => void) {}
  request(
    params: Record<string, unknown>,
    signal?: AbortSignal,
    eventType:
      | "subagent.requested"
      | "capability.requested"
      | "subagent.control" = "subagent.requested",
  ): Promise<RuntimeResult> {
    if (signal?.aborted) return Promise.resolve({ success: false, error: "Subagent cancelled" });
    const id = randomUUID();
    return new Promise((resolve) => {
      const abort = () => {
        if (eventType === "subagent.requested") this.publish({ type: "subagent.cancelled", id });
        if (eventType === "subagent.control") this.publish({ type: "subagent.wait_cancelled", id });
        this.respond({ id, result: { success: false, error: "Subagent cancelled" } });
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, cleanup: () => signal?.removeEventListener("abort", abort) });
      this.publish({ type: eventType, id, ...params });
    });
  }
  respond(params: Record<string, unknown>): RuntimeResult {
    const item = this.pending.get(String(params.id));
    if (!item) return { success: false, error: "Subagent request is no longer pending" };
    this.pending.delete(String(params.id));
    item.cleanup();
    item.resolve(params.result as RuntimeResult);
    return { success: true };
  }
  cancelAll(): void {
    this.publish({ type: "subagent.cancel_all", id: "all" });
  }
  close(): void {
    this.cancelAll();
    for (const id of this.pending.keys())
      this.respond({ id, result: { success: false, error: "Worker closed" } });
  }
}

const sandboxSelectionParameters = Type.Object({
  cwd: Type.String(),
  read_paths: Type.Array(Type.String(), { maxItems: 8 }),
  write_paths: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
});
export function subagentHarnessTool(
  bridge: SubagentBridge,
): AgentHarnessTool<{ env: NodeExecutionEnv }> {
  return {
    name: "subagent",
    label: "Subagent",
    description:
      "A role without tools inherits the Parent's eligible active tools; optional task tools only narrows them ([] means none). Scope/grant restrictions and per-call approvals still apply. Delegate a task to a named workspace agent (single), a sequential chain, or a bounded parallel group. The parent synthesizes the results. For confined execution, provide sandbox={cwd,read_paths,write_paths}; the server validates these selections against your existing permissions and binds an immutable grant. Child/model paths never authorize access directly. candidate_id is optional correlation metadata; candidate-only requests retain the legacy research adapter. wait_seconds bounds only waiting (0 dispatches in the background). Host execution limits still apply; use subagent_control to inspect, collect, resume or stop your tasks.",
    parameters: Type.Object({
      wait_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 600 })),
      tools: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
      sandbox: Type.Optional(sandboxSelectionParameters),
      agent: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
      candidate_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" })),
      chain: Type.Optional(
        Type.Array(
          Type.Object({
            sandbox: Type.Optional(sandboxSelectionParameters),
            agent: Type.String(),
            task: Type.String(),
            tools: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
            candidate_id: Type.Optional(
              Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" }),
            ),
          }),
          { maxItems: 8 },
        ),
      ),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            sandbox: Type.Optional(sandboxSelectionParameters),
            agent: Type.String(),
            task: Type.String(),
            tools: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
            candidate_id: Type.Optional(
              Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" }),
            ),
          }),
          { maxItems: 4 },
        ),
      ),
    }),
    async execute(_id, params, onUpdate, _ctx, invocation, context) {
      const cached = await invocation.getMemo("subagent-result");
      if (cached)
        return cached as unknown as {
          content: Array<{ type: "text"; text: string }>;
          details: unknown;
        };
      onUpdate({
        content: [{ type: "text", text: "Delegating…" }],
        details: { status: "running" },
      });
      const response = await bridge.request(
        { params, operationId: invocation.operationId, invocationId: invocation.invocationId },
        context.abortSignal,
      );
      // Harness records errors from thrown failures; an isError property on a
      // returned result is not part of its execution contract.
      if (!response.success) throw new Error(response.error ?? "Subagent failed");
      const result = response.data as {
        content: Array<{ type: "text"; text: string }>;
        details: unknown;
      };
      await invocation.setMemo("subagent-result", JSON.parse(JSON.stringify(result)));
      return result;
    },
  };
}

/** Observation/cleanup remains available even after an execution quota is spent. */
export function subagentControlTool(
  bridge: SubagentBridge,
): AgentHarnessTool<{ env: NodeExecutionEnv }> {
  return {
    name: "subagent_control",
    label: "Subagent tasks",
    description:
      "List, inspect, collect, resume or stop this session's own child tasks. Waiting can expire while execution continues. Collection resumes interrupted tasks under their original deadline and current permissions. Stopping cancels descendants. Observation and cleanup do not consume execution slots.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("collect"),
        Type.Literal("stop"),
      ]),
      task_id: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      wait_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 600 })),
    }),
    async execute(_id, params, _update, _ctx, _invocation, context) {
      const response = await bridge.request({ params }, context.abortSignal, "subagent.control");
      if (!response.success) throw new Error(response.error ?? "Subagent control failed");
      return response.data as { content: Array<{ type: "text"; text: string }>; details: unknown };
    },
  };
}
