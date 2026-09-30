import { randomUUID } from "node:crypto";
import type { RuntimeEvent, RuntimeResult } from "../agent-runtime-types.js";

type Pending = { resolve: (value: string | null) => void; reject: (error: Error) => void; cleanup: () => void };

/** Keeps browser interaction promises inside the worker that owns the tool call. */
export class InteractionBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly publish: (event: RuntimeEvent) => void) {}

  request(title: string, prefill: string, signal?: AbortSignal, options: { method?: "input" | "confirm"; kind?: "permission"; message?: string } = {}): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise<string | null>((resolve, reject) => {
      const onAbort = () => {
        this.resolve(id, null);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) });
      this.publish({ type: "extension_ui_request", id, method: options.method ?? "input", title, prefill,
        ...(options.kind ? { kind: options.kind } : {}), ...(options.message ? { message: options.message } : {}) });
    });
  }

  notify(type: string, params: Record<string, unknown>): RuntimeResult {
    if (type !== "extension_ui_response") return { success: false, code: "unsupported_notification", error: `unsupported notification: ${type}` };
    const id = params.id;
    if (typeof id !== "string") return { success: false, code: "invalid_request", error: "interaction id is required" };
    const response = params.cancelled === true ? null : typeof params.confirmed === "boolean" ? JSON.stringify(params.confirmed)
      : typeof params.value === "string" ? params.value : JSON.stringify(params.value ?? null);
    return this.resolve(id, response)
      ? { success: true }
      : { success: false, code: "not_found", error: "interaction is no longer pending" };
  }

  async confirmPermission(title: string, message: string, signal?: AbortSignal): Promise<boolean> {
    const value = await this.request(title, "", signal, { method: "confirm", kind: "permission", message });
    return value === "true";
  }

  close(): void {
    for (const [id, item] of this.pending) {
      this.pending.delete(id);
      item.cleanup();
      item.reject(new Error("agent worker closed while waiting for browser interaction"));
    }
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
