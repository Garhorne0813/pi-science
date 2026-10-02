import { join, resolve } from "node:path";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { metadataRoot } from "../../storage/persistence.js";
import { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { AgentRuntimeStartOptions } from "./worker/protocol.js";
import { bindSubagentDispatch } from "./subagent-dispatch.js";

// Includes pending starts and workers belonging to every app-owned manager.
const capacity = new Set<symbol>();
const processOwners = new Map<string, symbol>();
function workerLimit(): number {
  const value = Number(process.env.PI_SCIENCE_AGENT_MAX_WORKERS ?? 16);
  return Number.isSafeInteger(value) && value > 0 ? value : 16;
}

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
    if (capacity.size >= workerLimit()) throw new Error("Agent worker capacity limit reached");
    const slot = Symbol(key); capacity.add(slot);
    const requestedOwner = options.sessionId ? sessionKey(options.cwd, options.sessionId) : undefined;
    if (requestedOwner && processOwners.has(requestedOwner)) {
      capacity.delete(slot);
      throw new Error("Agent session is already owned by another manager");
    }
    if (requestedOwner) processOwners.set(requestedOwner, slot);
    let runtime: AgentCoreRuntimeClient;
    try { runtime = await AgentCoreRuntimeClient.start({ ...options, deferActivation: true }); }
    catch (error) { capacity.delete(slot); if (requestedOwner) processOwners.delete(requestedOwner); throw error; }
    const release = () => {
      capacity.delete(slot);
      for (const [identity, owner] of processOwners) if (owner === slot) processOwners.delete(identity);
    };
    runtime.once("exit", release);
    bindSubagentDispatch(this, runtime, options);
    const canonical = sessionKey(options.cwd, runtime.sessionId);
    if (processOwners.has(canonical) && processOwners.get(canonical) !== slot) {
      await runtime.shutdown();
      throw new Error("Agent session is already owned by another manager");
    }
    processOwners.set(canonical, slot);
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
    if (!options.deferActivation) {
      try {
        const activated = await runtime.sendCommand("activate");
        if (!activated.success) throw new Error(activated.error ?? "Unable to activate worker");
      } catch (error) { await this.stop(key); throw error; }
    }
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
