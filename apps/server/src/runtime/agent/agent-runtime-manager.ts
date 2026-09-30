import { join, resolve } from "node:path";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { metadataRoot } from "../../storage/persistence.js";
import { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { AgentRuntimeStartOptions } from "./worker/protocol.js";

function sessionKey(cwd: string, sessionId: string): string {
  return `${resolve(cwd)}\0${sessionId}`;
}

function idleTimeoutMs(): number {
  const raw = process.env.PI_SCIENCE_IDLE_RUNTIME_MS;
  if (raw === undefined || raw === "") return 30 * 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Owns one child process per durable session and deduplicates concurrent opens. */
export class AgentRuntimeManager {
  private readonly runtimes = new Map<string, AgentCoreRuntimeClient>();
  private readonly pendingStarts = new Map<string, Promise<AgentCoreRuntimeClient>>();
  private readonly owners = new Map<string, string>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  async start(key: string, options: AgentRuntimeStartOptions): Promise<AgentCoreRuntimeClient> {
    const cwd = await validateWorkspaceCwd(options.cwd);
    const requestedRoot = resolve(options.sessionsRoot);
    const acceptedRoots = [options.cwd, cwd].map((workspace) => join(metadataRoot(workspace), "agent-sessions"));
    if (!acceptedRoots.includes(requestedRoot)) {
      throw new Error("agent sessions root must be workspace-local");
    }
    const ownerKey = options.sessionId ? sessionKey(cwd, options.sessionId) : key;
    const ownedBy = this.owners.get(ownerKey);
    if (ownedBy) {
      const runtime = this.runtimes.get(ownedBy);
      if (runtime && !runtime.isClosed) return runtime;
    }
    const existing = this.runtimes.get(key);
    if (existing && !existing.isClosed) return existing;
    const pending = this.pendingStarts.get(ownerKey);
    if (pending) return pending;
    const started = this.startOnce(key, { ...options, cwd, sessionsRoot: join(metadataRoot(cwd), "agent-sessions") }, ownerKey);
    this.pendingStarts.set(ownerKey, started);
    try { return await started; }
    finally {
      if (this.pendingStarts.get(ownerKey) === started) this.pendingStarts.delete(ownerKey);
    }
  }

  get(key: string): AgentCoreRuntimeClient | undefined {
    const runtime = this.runtimes.get(key);
    return runtime && !runtime.isClosed ? runtime : undefined;
  }

  async stop(key: string): Promise<void> {
    const runtime = this.runtimes.get(key);
    if (!runtime) return;
    this.forget(key, runtime);
    await runtime.shutdown();
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(this.pendingStarts.values());
    const entries = [...this.runtimes.entries()];
    for (const [key, runtime] of entries) this.forget(key, runtime);
    await Promise.allSettled(entries.map(([, runtime]) => runtime.shutdown()));
  }

  get processCount(): number { return this.runtimes.size; }

  private async startOnce(key: string, options: AgentRuntimeStartOptions, ownerKey: string): Promise<AgentCoreRuntimeClient> {
    const runtime = await AgentCoreRuntimeClient.start(options);
    const canonical = sessionKey(options.cwd, runtime.sessionId);
    const otherOwner = this.owners.get(canonical);
    if (otherOwner && otherOwner !== key) {
      await runtime.shutdown();
      throw new Error(`session ${runtime.sessionId} is already owned by another worker`);
    }
    this.runtimes.set(key, runtime);
    this.owners.set(ownerKey, key);
    this.owners.set(canonical, key);
    runtime.once("exit", () => this.forget(key, runtime));
    runtime.on("event", () => this.scheduleIdleCheck(key, runtime));
    this.scheduleIdleCheck(key, runtime);
    return runtime;
  }

  private forget(key: string, runtime: AgentCoreRuntimeClient): void {
    if (this.runtimes.get(key) !== runtime) return;
    this.runtimes.delete(key);
    const timer = this.idleTimers.get(key);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(key);
    for (const [identity, owner] of this.owners) if (owner === key) this.owners.delete(identity);
  }

  private scheduleIdleCheck(key: string, runtime: AgentCoreRuntimeClient): void {
    const prior = this.idleTimers.get(key);
    if (prior) clearTimeout(prior);
    const delay = idleTimeoutMs();
    if (delay <= 0 || runtime.isClosed) return;
    const timer = setTimeout(() => void this.evictIfIdle(key, runtime), delay);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  private async evictIfIdle(key: string, runtime: AgentCoreRuntimeClient): Promise<void> {
    if (this.runtimes.get(key) !== runtime) return;
    this.idleTimers.delete(key);
    try {
      const state = await runtime.sendCommand("get_state");
      const data = state.data && typeof state.data === "object" ? state.data as Record<string, unknown> : {};
      const queued = Array.isArray(data.queues) && data.queues.length > 0;
      if (!state.success || data.busy || queued || data.pendingInteraction) {
        this.scheduleIdleCheck(key, runtime);
        return;
      }
      await this.stop(key);
    } catch {
      if (!runtime.isClosed) this.scheduleIdleCheck(key, runtime);
    }
  }
}
