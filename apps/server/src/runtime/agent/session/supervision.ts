import type { Live } from "./types.js";
import { identity, noProgressTimeoutMs } from "./identity.js";
import type { SessionContext } from "./context.js";

type Context = Pick<SessionContext, "events" | "live" | "manager" | "open" | "probe" | "recover" | "recovering" | "recoveryAttempts" | "recoveryTimers" | "scheduleWatchdog" | "stopping" | "withMutation">;

export function scheduleWatchdog(context: Context, item: Live): void {
  const delay = Number(process.env.PI_SCIENCE_EVENT_WATCHDOG_MS ?? 60000);
  if (context.stopping || item.suppressRecovery || item.runtime.isClosed || !item.expectedOperationId || !Number.isFinite(delay) || delay <= 0) {
    if (item.watchdog) clearTimeout(item.watchdog);
    item.watchdog = undefined;
    return;
  }
  // Keep probes periodic. Non-progress events must not postpone supervision.
  if (item.watchdog) return;
  item.watchdog = setTimeout(() => { item.watchdog = undefined; void context.probe(item); }, delay);
  item.watchdog.unref?.();
}

export async function probe(context: Context, item: Live): Promise<void> {
  if (context.stopping || context.live.get(identity(item.runtime.cwd, item.runtime.sessionId)) !== item) return;
  try {
    const result = await item.runtime.sendCommand("get_state", {}, 5000);
    if (!result.success) throw new Error(String(result.error));
    const data = result.data;
    if (!data) throw new Error("Worker returned no snapshot");
    if (context.stopping || context.live.get(identity(item.runtime.cwd, item.runtime.sessionId)) !== item || !item.expectedOperationId) return;
    if (data.faulted || Number(data.eventSequence ?? 0) > item.eventSequence) { await context.recover(item); return; }
    const now = Date.now();
    if (data.pendingInteraction) item.interactionWaitStartedAt ??= now;
    else if (item.interactionWaitStartedAt !== undefined) {
      // Waiting for a person is not an agent-loop stall. Exclude that time
      // without counting successful IPC probes as operation progress.
      item.lastProgressAt += now - item.interactionWaitStartedAt;
      item.interactionWaitStartedAt = undefined;
    }
    if (data.busy && !data.pendingInteraction && now - item.lastProgressAt >= noProgressTimeoutMs()) {
      await context.recover(item, true);
      return;
    }
    if (!data.busy && item.expectedOperationId && data.lastResult?.operationId === item.expectedOperationId) {
      item.runtime.emit("event", { type: "operation.settled", runId: data.lastResult.operationId, status: data.lastResult.status, recovery: true });
    } else context.scheduleWatchdog(item);
  } catch { await context.recover(item); }
}

export function recover(context: Context, item: Live, force = false): Promise<void> {
  const cwd = item.runtime.cwd, sessionId = item.runtime.sessionId;
  const key = identity(cwd, sessionId);
  if (context.stopping) return Promise.resolve();
  const existing = context.recovering.get(key);
  if (existing) return existing;
  const work = context.withMutation(cwd, sessionId, async () => {
    if (context.stopping) return;
    const current = context.live.get(key);
    if (current && current !== item && !current.runtime.isClosed) return;
    const attempt = (context.recoveryAttempts.get(key) ?? 0) + 1;
    context.recoveryAttempts.set(key, attempt);
    const exhausted = attempt > 3;
    item.suppressRecovery = true;
    if (item.watchdog) clearTimeout(item.watchdog);
    if (!exhausted) await context.events.publish(cwd, sessionId, { type: "error", sessionId, code: "worker_recovering", recoverable: true,
      message: "The agent worker stopped responding; restoring its durable operation." });
    context.events.expectExit(item.runtime);
    // Graceful Harness.close can cancel/settle an operation. A hung loop must
    // instead retain its checkpoint so the replacement worker can resume it.
    if ((force || exhausted) && !item.runtime.isClosed) item.runtime.child.kill("SIGKILL");
    await context.manager.stop(item.key); // Await exit before opening the same durable session.
    if (context.live.get(key) === item) context.live.delete(key);
    if (context.stopping) return;
    if (exhausted) {
      await context.events.publish(cwd, sessionId, { type: "error", sessionId, code: "worker_recovery_failed", terminal: true,
        message: "The agent operation stalled repeatedly; automatic recovery has stopped. Reopen the session to retry." });
      await context.events.publish(cwd, sessionId, { type: "runtime.paused", sessionId });
      return;
    }
    const opened = await context.open(cwd, sessionId, item.config);
    if ("success" in opened) {
      await context.events.publish(cwd, sessionId, { type: "error", sessionId, code: "worker_recovery_failed", terminal: attempt >= 3, message: String(opened.error) });
      if (attempt < 3) {
        const timer = setTimeout(() => { context.recoveryTimers.delete(key); void context.recover(item); }, 250 * attempt);
        timer.unref?.();
        context.recoveryTimers.set(key, timer);
      }
    } else if (!opened.busy) {
      // A replacement can be idle because Core already persisted the result
      // before the previous worker lost its terminal event. Reconcile from
      // that authoritative result; process liveness alone cannot settle it.
      const operationId = item.expectedOperationId;
      const result = operationId ? await opened.runtime.sendCommand("get_operation_result", { operationId }) : undefined;
      if (result?.success && result.data) opened.runtime.emit("event", {
        type: "operation.settled", runId: result.data.operationId, status: result.data.status, recovery: true,
      });
      else await context.events.publish(cwd, sessionId, { type: "runtime.paused", sessionId });
    }
  }).catch(async (error) => {
    try { await context.events.publish(cwd, sessionId, { type: "error", sessionId, code: "worker_recovery_failed", terminal: true, message: String(error) }); } catch { /* The event store may itself be unavailable. */ }
  }).finally(() => { if (context.recovering.get(key) === work) context.recovering.delete(key); });
  context.recovering.set(key, work);
  return work;
}
