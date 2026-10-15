import { AGENT_NAME_PATTERN, resolveAgentDefinition, childToolAllowance } from "./agent-definitions.js";
import { z } from "zod";
import { readJson, withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { createHash } from "node:crypto";
import { openHiddenTask, runHiddenPrompt } from "./hidden-agent-task.js";
import type { AgentRuntimeManager } from "./agent-runtime-manager.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { AgentRuntimeStartOptions } from "./worker/protocol.js";
import type { RuntimeEvent } from "./agent-runtime-types.js";

const task = z.object({ agent: z.string().regex(AGENT_NAME_PATTERN), task: z.string().min(1).max(200_000) }).strict();
const paramsSchema = z.union([task, z.object({ chain: z.array(task).min(1).max(8) }).strict(), z.object({ tasks: z.array(task).min(1).max(4) }).strict()]);
/** Child requests travel over the owning worker's authenticated IPC connection. */
export function bindSubagentDispatch(manager: AgentRuntimeManager, parent: AgentCoreRuntimeClient, options: AgentRuntimeStartOptions): () => Promise<void> {
  const pending = new Set<Promise<unknown>>();
  const track = (value: Promise<unknown>) => {
    pending.add(value);
    const done = () => pending.delete(value);
    void value.then(done, done);
  };
  const active = new Map<string, Set<string>>();
  const cancelled = new Set<string>();
  const cancel = async (id: string) => {
    cancelled.add(id);
    const keys = active.get(id);
    if (keys) await Promise.allSettled([...keys].map((key) => manager.stop(key)));
  };
  parent.once("exit", () => { track(Promise.allSettled([...active.keys()].map(cancel))); });
  parent.on("event", (event: RuntimeEvent) => {
    const id = String(event.id ?? "");
    if (event.type === "subagent.cancelled") { track(cancel(id)); return; }
    if (event.type !== "subagent.requested") return;
    const run = async () => {
      if ((options.depth ?? 0) >= 2) throw new Error("Subagent depth limit reached");
      const params = paramsSchema.parse(event.params);
      if (typeof event.operationId !== "string" || typeof event.invocationId !== "string") throw new Error("Missing subagent invocation identity");
      const tasks = "chain" in params ? params.chain : "tasks" in params ? params.tasks : [params];
      const mode = "chain" in params ? "chain" : "tasks" in params ? "parallel" : "single";
      const keys = new Set<string>(); active.set(id, keys);
      const deadline = Date.now() + 10 * 60_000;
      const execute = async (item: z.infer<typeof task>, index: number, previous = "") => {
        const key = `subagent:${options.cwd}:${parent.sessionId}:${event.operationId}:${event.invocationId}:${index}`;
        const resultPath = workspaceFile(options.cwd, `agent-task-results/${createHash("sha256").update(key).digest("hex")}.json`);
        return withFileWriteLock(resultPath, async () => {
          if (cancelled.has(id) || parent.isClosed) throw new Error("Subagent cancelled");
          const saved = await readJson<Record<string, unknown> | null>(resultPath, null);
          if (saved) return saved;
          const resources = await parent.sendCommand("get_skills");
          const namespace = item.agent.includes("/") ? item.agent.split("/")[0] : undefined;
          if (namespace && (!resources.success || !resources.data?.skills?.some((skill: { name: string; enabled: boolean }) => skill.name === namespace && skill.enabled))) throw new Error(`Unknown or disabled agent: ${item.agent}`);
          const policy = resources.success ? resources.data?.policy ?? options.skillPolicy : options.skillPolicy;
          const definition = await resolveAgentDefinition(options.cwd, item.agent, policy);
          const prompt = definition.prompt;
          const state = await parent.sendCommand("get_state");
          if (!state.success || !state.data) throw new Error("Cannot establish parent tool permissions");
          const allowedTools = childToolAllowance(definition.tools, state.data.activeTools, item.agent);
          keys.add(key);
          try {
            const child = await openHiddenTask(manager, key, { ...options, sessionId: undefined, systemPrompt: prompt,
              depth: (options.depth ?? 0) + 1, allowedTools, delegatedAgent: item.agent,
              budgetOperationId: options.budgetOperationId ?? String(event.operationId), skillPolicy: policy ?? { mode: "inherit" } }, parent.sessionId);
            if (cancelled.has(id) || parent.isClosed) throw new Error("Subagent cancelled");
            const authorize = (request: RuntimeEvent) => {
              if (request.type !== "capability.requested") return;
              const check = async () => {
                if (cancelled.has(id) || parent.isClosed) throw new Error("Subagent cancelled");
                const resources = await parent.sendCommand("get_skills");
                const state = await parent.sendCommand("get_state");
                if (!resources.success || !state.success || !state.data) throw new Error("Parent permissions unavailable");
                if (namespace && !resources.data?.skills.some((skill) => skill.name === namespace && skill.enabled)) throw new Error(`Unknown or disabled agent: ${item.agent}`);
                const current = await resolveAgentDefinition(options.cwd, item.agent, resources.data?.policy);
                const tool = String(request.tool);
                if (!allowedTools.includes(tool) || !childToolAllowance(current.tools, state.data.activeTools, item.agent).includes(tool)) throw new Error(`Delegated tool revoked: ${tool}`);
                return { success: true };
              };
              track(check().then((result) => child.sendNotification("subagent_response", { id: String(request.id), result }),
                (error) => child.sendNotification("subagent_response", { id: String(request.id), result: { success: false, error: String(error) } })).catch(() => undefined));
            };
            child.on("event", authorize);
            let output: string;
            try { output = await runHiddenPrompt(child, item.task.replaceAll("{previous}", previous), `${event.invocationId}:${index}`, deadline); }
            finally { child.off("event", authorize); }
            const stats = await child.sendCommand("get_session_stats");
            const result = { agent: item.agent, task: item.task, childSessionId: child.sessionId, exitCode: 0,
              output, usage: stats.success ? stats.data : undefined };
            await writeJsonAtomic(resultPath, result);
            return result;
          } finally { keys.delete(key); await manager.stop(key); }
        });
      };
      try {
        const results: Record<string, unknown>[] = [];
        if (mode === "chain") {
          for (let index = 0; index < tasks.length; index++) results.push(await execute(tasks[index]!, index, String(results.at(-1)?.output ?? "")));
        } else if (mode === "parallel") {
          const settled = await Promise.allSettled(tasks.map((item, index) => execute(item, index)));
          for (let index = 0; index < settled.length; index++) {
            const value = settled[index]!;
            results.push(value.status === "fulfilled" ? value.value : { agent: tasks[index]!.agent, exitCode: 1, error: String(value.reason) });
          }
        } else results.push(await execute(tasks[0]!, 0));
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        for (const result of results) {
          const child = (result.usage as { usage?: typeof usage } | undefined)?.usage;
          if (!child) continue;
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += child[key];
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += child.cost[key];
        }
        return { content: [{ type: "text", text: results.map((value) => `${value.agent}: ${value.output ?? value.error}`).join("\n\n") }], usage,
          details: { mode, results: results.map((value) => ({ ...value,
            ...(typeof value.task === "string" ? { task: value.task.slice(0, 4000) } : {}),
            ...(typeof value.output === "string" ? { output: value.output.slice(0, 6000), outputTruncated: value.output.length > 6000 } : {}),
          })) } };
      } finally { active.delete(id); cancelled.delete(id); }
    };
    track(run().then((data) => parent.sendNotification("subagent_response", { id, result: { success: true, data } }),
      (error) => parent.sendNotification("subagent_response", { id, result: { success: false, error: String(error) } })).catch(() => undefined));
  });
  return async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
}
