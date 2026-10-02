import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { RuntimeEvent, RuntimeResult } from "../agent-runtime-types.js";

export class SubagentBridge {
  private readonly pending = new Map<string, { resolve: (result: RuntimeResult) => void; cleanup: () => void }>();
  constructor(private readonly publish: (event: RuntimeEvent) => void) {}
  request(params: Record<string, unknown>, signal?: AbortSignal): Promise<RuntimeResult> {
    if (signal?.aborted) return Promise.resolve({ success: false, error: "Subagent cancelled" });
    const id = randomUUID();
    return new Promise((resolve) => {
      const abort = () => {
        this.publish({ type: "subagent.cancelled", id });
        this.respond({ id, result: { success: false, error: "Subagent cancelled" } });
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, cleanup: () => signal?.removeEventListener("abort", abort) });
      this.publish({ type: "subagent.requested", id, ...params });
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
  close(): void {
    for (const id of this.pending.keys()) this.respond({ id, result: { success: false, error: "Worker closed" } });
  }
}

export function subagentHarnessTool(bridge: SubagentBridge): AgentHarnessTool<{ env: NodeExecutionEnv }> {
  return {
    name: "subagent", label: "Subagent", description: "Delegate a task to a named workspace agent (single), a sequential chain, or a bounded parallel group. The parent synthesizes the results. Async and workflow modes are unavailable.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()),
      chain: Type.Optional(Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), { maxItems: 8 })),
      tasks: Type.Optional(Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), { maxItems: 4 })),
    }),
    async execute(_id, params, onUpdate, _ctx, invocation, context) {
      const cached = await invocation.getMemo("subagent-result");
      if (cached) return cached as unknown as { content: Array<{ type: "text"; text: string }>; details: unknown };
      onUpdate({ content: [{ type: "text", text: "Delegating…" }], details: { status: "running" } });
      const response = await bridge.request({ params, operationId: invocation.operationId, invocationId: invocation.invocationId }, context.abortSignal);
      const result = response.success ? response.data as { content: Array<{ type: "text"; text: string }>; details: unknown }
        : { content: [{ type: "text" as const, text: response.error ?? "Subagent failed" }], details: { error: response.error }, isError: true };
      if (response.success) await invocation.setMemo("subagent-result", JSON.parse(JSON.stringify(result)));
      return result;
    },
  };
}
