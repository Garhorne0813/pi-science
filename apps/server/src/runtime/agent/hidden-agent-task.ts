import { createHash } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { metadataRoot, readJson, withFileWriteLock, writeJsonAtomic, workspaceFile } from "../../storage/persistence.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import type { AgentRuntimeManager } from "./agent-runtime-manager.js";
import type { AgentRuntimeStartOptions } from "./worker/protocol.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { RuntimeEvent } from "./agent-runtime-types.js";
import { promptOperationId } from "./agent-message.js";

/** Persist child ownership before any activation/admission; reopening uses the same v4 file. */
export async function openHiddenTask(manager: AgentRuntimeManager, key: string, options: AgentRuntimeStartOptions, parent: string,
  purpose: "subagent" | "research" | "review" = "subagent"): Promise<AgentCoreRuntimeClient> {
  const path = workspaceFile(options.cwd, `agent-task-links/${createHash("sha256").update(key).digest("hex")}.json`);
  const sessionId = await withFileWriteLock(path, async () => {
    const saved = await readJson<{ sessionId?: string }>(path, {});
    if (saved.sessionId) return saved.sessionId;
    const env = new NodeExecutionEnv({ cwd: options.cwd });
    const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: options.sessionsRoot });
    try {
      const session = await repo.create({ cwd: options.cwd, parentSessionId: parent }, BACKGROUND_CONTEXT);
      const id = session.metadata.id;
      await session.close(BACKGROUND_CONTEXT);
      const target = await new AgentSessionRepository().findPath(options.cwd, id);
      if (!target) throw new Error("Hidden agent session has no transcript");
      await new AgentSessionRegistry().register(options.cwd, id, target, undefined, { purpose, parentSessionId: parent });
      await writeJsonAtomic(path, { sessionId: id, parent, key });
      return id;
    } finally { await repo.close(BACKGROUND_CONTEXT); await env.cleanup(BACKGROUND_CONTEXT); }
  });
  return manager.start(key, { ...options, sessionId, parentSessionId: parent, deferActivation: true });
}

export function hiddenSessionsRoot(cwd: string): string { return join(metadataRoot(cwd), "agent-sessions"); }

/** Listener registration precedes activation, including recovery of an already accepted child prompt. */
export async function runHiddenPrompt(runtime: AgentCoreRuntimeClient, message: string, clientId: string, deadline: number,
  observe?: (event: RuntimeEvent) => void): Promise<string> {
  const expected = promptOperationId(runtime.sessionId, clientId);
  let cleanup = () => {};
  let finish!: (error?: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    const event = (value: RuntimeEvent) => {
      observe?.(value);
      if (value.type === "agent_settled" && value.runId === expected) finish(value.status === "completed" ? undefined : new Error(`Child operation ${value.status}`));
    };
    const exit = () => finish(new Error("Hidden agent worker exited"));
    const timer = setTimeout(() => finish(new Error("Hidden agent timed out")), Math.max(1, deadline - Date.now()));
    cleanup = () => { clearTimeout(timer); runtime.off("event", event); runtime.off("exit", exit); };
    finish = (error) => { cleanup(); error ? reject(error) : resolve(); };
    runtime.on("event", event); runtime.once("exit", exit);
  });
  // Install a rejection handler while asynchronous admission is still in flight.
  void completed.catch(() => undefined);
  try {
    const state = await runtime.sendCommand("get_state");
    if (!state.success) throw new Error(state.error ?? "Unable to read child state");
    const data = state.data as { busy: boolean; lastResult?: { operationId: string; status: string }; operation?: { id: string } };
    if (!data.busy && data.lastResult?.operationId === expected) finish(data.lastResult.status === "completed" ? undefined : new Error(`Child operation ${data.lastResult.status}`));
    else {
      if (data.busy && data.operation?.id !== expected) throw new Error("Child is executing another operation");
      const activation = await runtime.sendCommand("activate");
      if (!activation.success) throw new Error(activation.error ?? "Unable to activate child");
      if (!data.busy) {
        const admitted = await runtime.sendCommand("prompt", { message, client_message_id: clientId });
        if (!admitted.success) throw new Error(admitted.error ?? "Child rejected prompt");
        if (admitted.deduplicated) {
          const result = await runtime.sendCommand("get_operation_result", { operationId: expected });
          const record = result.data as { status?: string } | undefined;
          finish(record?.status === "completed" ? undefined : new Error(`Child operation ${record?.status ?? "has no result"}`));
        }
      }
    }
    await completed;
    const history = await runtime.sendCommand("get_messages");
    if (!history.success) throw new Error(history.error ?? "Unable to read child result");
    const entries = (history.data as { messages: Array<{ message: { role: string; client_message_id?: string; content: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string } }> }).messages;
    const start = entries.findIndex((entry) => entry.message.role === "user" && entry.message.client_message_id === clientId);
    if (start < 0) throw new Error("Child prompt is missing from durable history");
    const next = entries.findIndex((entry, index) => index > start && entry.message.role === "user");
    const final = entries.slice(start + 1, next < 0 ? undefined : next).findLast((entry) => entry.message.role === "assistant")?.message;
    if (!final || ["error", "aborted"].includes(final.stopReason ?? "")) throw new Error(final?.errorMessage ?? "Child did not complete successfully");
    const text = final.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    if (Buffer.byteLength(text) > 2_000_000) throw new Error("Hidden agent response exceeds 2 MB");
    return text;
  } finally { cleanup(); }
}
