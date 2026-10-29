import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeEvent, RuntimeResult } from "../agent-runtime-types.js";
import { ApprovalQueue, runtimeApprovalQueue, type AcquireApproval } from "../approval-queue.js";

type McpToolGrant = { connectorId: string; toolName: string; connectorRevision?: number; settingsRevision?: number };

type Pending = { resolve: (value: string | null) => void; reject: (error: Error) => void; cleanup: () => void; submitted?: { value: string | null } };
type RequestOptions = { toolCallId?: string; method?: "input" | "confirm" | "select"; kind?: "permission"; message?: string; mcpGrant?: McpToolGrant; options?: Array<{ label: string; value: string }> };

/** Keeps browser interaction promises inside the worker that owns the tool call. */
export class InteractionBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly queue = new ApprovalQueue();
  private readonly lifetime = new AbortController();
  private readonly permissionScope = new AsyncLocalStorage<boolean>();
  private waiting = 0;

  constructor(private readonly publish: (event: RuntimeEvent) => void, private readonly acquireApproval: AcquireApproval = (key, signal) => runtimeApprovalQueue.acquire(key, signal)) {}

  get hasPending(): boolean { return this.pending.size > 0 || this.waiting > 0; }

  /** Recheck and persist inside the lease; release before dispatching tool work. */
  async withPermission<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lifetime = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    this.waiting++;
    try {
      const leaveSession = await this.queue.acquire("session", lifetime);
      try {
        const release = await this.acquireApproval(key, lifetime);
        try { lifetime.throwIfAborted(); return await this.permissionScope.run(true, operation); }
        finally { release(); }
      } finally { leaveSession(); }
    } finally { this.waiting--; }
  }

  request(title: string, prefill: string, signal?: AbortSignal, options: RequestOptions = {}): Promise<string | null> {
    if (options.kind !== "permission" || this.permissionScope.getStore()) return this.requestNow(title, prefill, signal, options);
    return this.requestPermission(title, prefill, signal, options);
  }

  private async requestPermission(title: string, prefill: string, signal: AbortSignal | undefined, options: RequestOptions): Promise<string | null> {
    const lifetime = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    this.waiting++;
    try {
      const release = await this.queue.acquire("session", lifetime);
      try { return await this.requestNow(title, prefill, lifetime, options); }
      finally { release(); }
    } finally { this.waiting--; }
  }

  private requestNow(title: string, prefill: string, signal?: AbortSignal, options: RequestOptions = {}): Promise<string | null> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("agent worker closed while waiting for browser interaction"));
    if (signal?.aborted) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise<string | null>((resolve, reject) => {
      const onAbort = () => {
        const item = this.pending.get(id);
        if (item?.submitted) { item.submitted.value = null; return; }
        if (this.resolve(id, null)) this.publish({ type: "interaction.resolved", id });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) });
      this.publish({ type: "interaction.requested", id, method: options.method ?? "input", title, prefill,
        ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
        ...(options.options ? { options: options.options } : {}), ...(options.kind ? { kind: options.kind } : {}), ...(options.message ? { message: options.message } : {}),
        ...(options.mcpGrant ? { mcpGrant: options.mcpGrant } : {}) });
    });
  }

  notify(type: string, params: Record<string, unknown>): RuntimeResult {
    if (type !== "extension_ui_response") return { success: false, code: "unsupported_notification", error: `unsupported notification: ${type}` };
    const id = params.id;
    if (typeof id !== "string") return { success: false, code: "invalid_request", error: "interaction id is required" };
    const item = this.pending.get(id);
    if (params.complete === true) {
      return item?.submitted && this.resolve(id, item.submitted.value)
        ? { success: true } : { success: false, code: "not_found", error: "interaction is no longer submitted" };
    }
    if (item?.submitted) return { success: false, code: "not_found", error: "interaction is already submitted" };
    const response = params.cancelled === true ? null : typeof params.confirmed === "boolean" ? JSON.stringify(params.confirmed)
      : typeof params.value === "string" ? params.value : JSON.stringify(params.value ?? null);
    // Always allow must finish persistence before the target lease is released.
    // Acknowledging submission first still prevents saving a stale interaction.
    if (params.deferResolution === true && item) { item.submitted = { value: response }; return { success: true }; }
    return this.resolve(id, response)
      ? { success: true }
      : { success: false, code: "not_found", error: "interaction is no longer pending" };
  }

  async confirmPermission(title: string, message: string, signal?: AbortSignal, toolCallId?: string, mcpGrant?: McpToolGrant): Promise<boolean> {
    const value = await this.request(title, "", signal, { method: "confirm", kind: "permission", message, toolCallId, mcpGrant });
    return value === "true";
  }

  close(): void {
    for (const [id, item] of this.pending) {
      this.pending.delete(id);
      item.cleanup();
      item.reject(new Error("agent worker closed while waiting for browser interaction"));
    }
    this.lifetime.abort(new Error("agent worker closed while waiting for browser interaction"));
  }

  private resolve(id: string, value: string | null): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    this.pending.delete(id);
    item.cleanup();
    item.resolve(value);
    return true;
  }
}
