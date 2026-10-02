import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { readJson, withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { createHash } from "node:crypto";
import { openHiddenTask, runHiddenPrompt } from "./hidden-agent-task.js";
import type { AgentRuntimeManager } from "./agent-runtime-manager.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { AgentRuntimeStartOptions } from "./worker/protocol.js";
import type { RuntimeEvent } from "./agent-runtime-types.js";

const task = z.object({ agent: z.string().regex(/^[a-zA-Z0-9_-]+$/), task: z.string().min(1).max(200_000) }).strict();
const paramsSchema = z.union([task, z.object({ chain: z.array(task).min(1).max(8) }).strict(), z.object({ tasks: z.array(task).min(1).max(4) }).strict()]);
const builtin: Record<string, string> = {
  planner: "Plan a conservative scientific investigation. Inspect evidence and return a concrete strategy.",
  delegate: "Produce a self-contained scientific candidate following the supplied strategy and constraints.",
  reviewer: "Review scientific evidence, identify errors and limitations, and propose corrections.",
};

/** Child requests travel over the owning worker's authenticated IPC connection. */
export function bindSubagentDispatch(manager: AgentRuntimeManager, parent: AgentCoreRuntimeClient, options: AgentRuntimeStartOptions): void {
  const active = new Map<string, Set<string>>();
  const cancelled = new Set<string>();
  const cancel = async (id: string) => {
    cancelled.add(id);
    const keys = active.get(id);
    if (keys) await Promise.allSettled([...keys].map((key) => manager.stop(key)));
  };
  parent.once("exit", () => { void Promise.allSettled([...active.keys()].map(cancel)); });
  parent.on("event", (event: RuntimeEvent) => {
    const id = String(event.id ?? "");
    if (event.type === "subagent_cancel") { void cancel(id); return; }
    if (event.type !== "subagent_request") return;
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
          let prompt = builtin[item.agent];
          let allowedTools = ["read"];
          try {
            const markdown = await readFile(join(options.cwd, ".pi", "agents", `${item.agent}.md`), "utf8");
            const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
            const metadata = match ? parse(match[1]!) as { tools?: string | string[] } : {};
            prompt = match ? markdown.slice(match[0].length) : markdown;
            if (metadata.tools) allowedTools = Array.isArray(metadata.tools) ? metadata.tools : metadata.tools.split(",").map((name) => name.trim());
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !prompt) throw error;
          }
          if (!prompt) throw new Error(`Unknown agent: ${item.agent}`);
          // A child may narrow its parent's tools, never expand that allowance.
          if (options.allowedTools) allowedTools = allowedTools.filter((name) => options.allowedTools!.includes(name));
          allowedTools = allowedTools.filter((name) => name !== "ask_user_question" && !name.startsWith("mcp_"));
          keys.add(key);
          try {
            const child = await openHiddenTask(manager, key, { ...options, sessionId: undefined, systemPrompt: prompt,
              depth: (options.depth ?? 0) + 1, allowedTools, skillPolicy: options.skillPolicy ?? { mode: "inherit" } }, parent.sessionId);
            if (cancelled.has(id) || parent.isClosed) throw new Error("Subagent cancelled");
            const output = await runHiddenPrompt(child, item.task.replaceAll("{previous}", previous), `${event.invocationId}:${index}`, deadline);
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
    void run().then((data) => parent.sendNotification("subagent_response", { id, result: { success: true, data } }),
      (error) => parent.sendNotification("subagent_response", { id, result: { success: false, error: String(error) } })).catch(() => undefined);
  });
}
