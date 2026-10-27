import { beginApprovalTransition, finishApprovalTransition } from "../../sandbox/approval-transition.js";
import { channel } from "node:diagnostics_channel";
import { readSessionApproval, saveSessionApproval } from "../../sandbox/session-approval.js";
import type { ApprovalMode } from "@pi-science/contracts";
import type { RuntimeResult } from "../agent-runtime-types.js";
import { identity } from "./identity.js";
import type { SessionContext } from "./context.js";

type Context = Pick<SessionContext, "approvalRetirements" | "events" | "live" | "manager" | "opening" | "recovering" | "recoveryTimers" | "repository" | "server" | "stopForReload" | "withMutation">;

export function approvalTransitionPending(context: Context, cwd: string, sessionId: string): boolean {
 return context.approvalRetirements.has(identity(cwd, sessionId));
}

export async function setApprovalMode(context: Context, cwd: string, sessionId: string, mode: ApprovalMode, revision: number): Promise<RuntimeResult> {
  const startedAt = performance.now();
  let revokeMs = 0; let persistenceMs = 0; let workerRestartCount = 0; let kernelRestartCount = 0; let mcpReconnectCount = 0;
  let fromMode: ApprovalMode | undefined;
  const result = await context.withMutation(cwd, sessionId, async () => {
    const key = identity(cwd, sessionId);
    const live = context.live.get(key);
    if (context.opening.has(key) || context.recovering.has(key) || context.recoveryTimers.has(key)
      || live?.busy || live?.expectedOperationId || live && context.manager.hasActiveTasks(live.runtime)) {
      return { success: false, code: "session_busy", error: "Stop the current task before changing approval mode" };
    }
    if (!live && !await context.repository.findPath(cwd, sessionId)) return { success: false, code: "not_found", error: "Session not found" };
    try {
      const current = await readSessionApproval(cwd, sessionId);
      fromMode = current.mode;
      if (current.revision !== revision) return { success: false, code: "approval_revision_conflict", error: "Approval mode changed; reload and retry", data: current };
      if (current.mode === mode && !context.approvalRetirements.has(key)) return { success: true, data: { ...current, runtimeRestarted: false } };
      let boundProcesses = 0;
      if (live) {
        const snapshot = await live.runtime.sendCommand("get_state");
        const state = snapshot.data;
        boundProcesses = state?.approvalBoundProcesses ?? 0;
        if (!snapshot.success || !state || state.busy || state.operation || state.pendingInteraction || state.faulted || state.queues.length > 0
          || context.manager.hasActiveTasks(live.runtime)) {
          return { success: false, code: "session_busy", error: "Session is active or its state cannot be verified" };
        }
      }
      const resources = context.server.hasApprovalResources?.(cwd, sessionId) ?? true;
      // Kernels can be retired independently. Locally spawned MCP processes
      // and full downgrades retain the verified Worker shutdown fallback.
      const previouslyBlocked = context.approvalRetirements.has(key);
      const restart = previouslyBlocked || process.env.PI_SCIENCE_APPROVAL_HOT_SWITCH === "0"
        || current.mode === "full" || boundProcesses > 0 || resources && !context.server.revokeApprovalResources;
      context.approvalRetirements.set(key, context.approvalRetirements.get(key) ?? live ?? null);
      beginApprovalTransition(cwd, sessionId);
      if (live) {
        live.approvalTransitionFailed = true;
        const barrier = await live.runtime.sendCommand("begin_approval_change", { revision });
        if (!barrier.success) {
          if (!previouslyBlocked) { context.approvalRetirements.delete(key); finishApprovalTransition(cwd, sessionId); live.approvalTransitionFailed = false; }
          return barrier;
        }
        if (context.manager.hasActiveTasks(live.runtime)) throw new Error("A background task entered during approval transition");
      }
      if (resources && context.server.revokeApprovalResources) {
        const revokeStartedAt = performance.now();
        try { kernelRestartCount = (await context.server.revokeApprovalResources(cwd, sessionId)).kernelRestartCount; }
        finally { revokeMs += performance.now() - revokeStartedAt; }
      }
      if (restart) {
        const revokeStartedAt = performance.now();
        try {
          const retiring = context.approvalRetirements.get(key) ?? live;
          if (retiring) {
            context.approvalRetirements.set(key, retiring);
            retiring.approvalTransitionFailed = true;
            if (context.live.get(key) === retiring) await context.stopForReload(retiring);
            else await context.manager.stop(retiring.key);
            workerRestartCount++;
            mcpReconnectCount = boundProcesses;
          } else if (resources && context.server.onWorkerExit) await context.server.onWorkerExit(cwd, sessionId);
          if (context.server.hasApprovalResources?.(cwd, sessionId)) throw new Error("Session capabilities were not fully revoked");
        } finally { revokeMs += performance.now() - revokeStartedAt; }
      }
      if (context.server.hasApprovalResources?.(cwd, sessionId)) throw new Error("Session capabilities were not fully revoked");
      const persistenceStartedAt = performance.now();
      const approval = await saveSessionApproval(cwd, sessionId, mode, revision);
      persistenceMs = performance.now() - persistenceStartedAt;
      if (live && !restart) {
        const released = await live.runtime.sendCommand("end_approval_change", { revision: approval.revision });
        if (!released.success) throw new Error("Worker could not apply the committed approval revision");
        live.approvalTransitionFailed = false;
      }
      context.approvalRetirements.delete(key);
      finishApprovalTransition(cwd, sessionId);
      const changed = { ...approval, runtimeRestarted: Boolean(live && restart), kernelRestartCount };
      await context.events.publish?.(cwd, sessionId, { type: "approval.mode.changed", sessionId, ...changed }).catch(() => undefined);
      return { success: true, data: changed };
    } catch (error) {
      const data = await readSessionApproval(cwd, sessionId).catch(() => undefined);
      const conflict = error instanceof Error && error.message.includes("Approval mode changed;");
      return { success: false, code: conflict ? "approval_revision_conflict" : "permission_transition_failed", error: String(error), data };
    }
  });
  channel("pi-science.approval-change").publish({
    sessionId, from: fromMode, to: mode, result: result.success ? "success" : result.code,
    total_ms: performance.now() - startedAt, validation_ms: Math.max(0, performance.now() - startedAt - persistenceMs - revokeMs), persistence_ms: persistenceMs,
    resource_revoke_ms: revokeMs, worker_restart_count: workerRestartCount, kernel_restart_count: kernelRestartCount, mcp_reconnect_count: mcpReconnectCount,
  });
  return result;
}
