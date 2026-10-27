import { pathIsInside } from "../../../support/platform-utils.js";
import { workspaceIdentity } from "../workspace-session-identity.js";
import type { AgentCoreRuntimeClient } from "../agent-runtime-client.js";
import { identity, failed } from "./identity.js";
import type { SessionContext } from "./context.js";

type Context = Pick<SessionContext, "approvalRetirements" | "events" | "live" | "mutations" | "opening" | "recovering" | "recoveryTimers" | "registry" | "repository" | "stopForReload">;

export async function waitForMutation(context: Context, cwd: string, sessionId: string): Promise<void> {
  await context.mutations.get(identity(cwd, sessionId))?.catch(() => undefined);
}

export async function owns(context: Context, cwd: string, sessionId: string): Promise<boolean> {
  return Boolean(await context.registry.get(cwd, sessionId))
    || context.live.has(identity(cwd, sessionId)) || (await context.repository.findPath(cwd, sessionId)) !== null;
}

export function liveSessions(context: Context, cwd: string): Array<{ id: string; cwd: string }> {
  return [...context.live.values()].filter((item) => workspaceIdentity(item.runtime.cwd) === workspaceIdentity(cwd) && !item.runtime.isClosed)
    .map((item) => ({ id: item.runtime.sessionId, cwd }));
}

export async function hasActiveOperations(context: Context, cwd: string): Promise<boolean> {
  const workspace = workspaceIdentity(cwd);
  const pending = () => [context.opening, context.mutations, context.recovering, context.recoveryTimers, context.approvalRetirements].some((entries) => [...entries.keys()].some((key) => pathIsInside(workspace, key.split("\0")[0]!, true)));
  if (pending()) return true;
  for (const item of context.live.values()) {
    if (!pathIsInside(workspace, workspaceIdentity(item.runtime.cwd), true) || item.runtime.isClosed) continue;
    if (item.busy || item.expectedOperationId) return true;
    const snapshot = await item.runtime.sendCommand("get_state").catch(failed);
    const data = snapshot.data;
    if (!snapshot.success || !data || data.busy || data.pendingInteraction || Array.isArray(data.queues) && data.queues.length > 0) return true;
  }
  return pending() || [...context.live.values()].some((item) => pathIsInside(workspace, workspaceIdentity(item.runtime.cwd), true) && !item.runtime.isClosed && (item.busy || Boolean(item.expectedOperationId)));
}

export async function closeIdleWorkspace(context: Context, cwd: string): Promise<void> {
  for (const item of [...context.live.values()]) if (pathIsInside(workspaceIdentity(cwd), workspaceIdentity(item.runtime.cwd), true)) await context.stopForReload(item);
  await context.events.flush(cwd);
}

export function liveRuntime(context: Context, cwd: string, expectedModel?: string): AgentCoreRuntimeClient | null {
  return [...context.live.values()].find((item) => workspaceIdentity(item.runtime.cwd) === workspaceIdentity(cwd) && !item.runtime.isClosed
    && (!expectedModel || item.model === expectedModel))?.runtime ?? null;
}
