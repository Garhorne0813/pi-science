import { randomUUID } from "node:crypto";
import type { AcquireApproval } from "../approval-queue.js";
import type { WorkerEvent } from "./protocol.js";

/** Worker-side leases; the parent owns ordering and reclaims leases on exit. */
export class ApprovalBridge {
  private readonly pending = new Map<string, () => void>();
  constructor(private readonly send: (event: WorkerEvent) => void) {}

  readonly acquire: AcquireApproval = (key, signal) => {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        this.send({ type: "approval_release", id });
      };
      const abort = () => { release(); reject(signal?.reason ?? new Error("Approval cancelled")); };
      this.pending.set(id, () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        resolve(release);
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.send({ type: "approval_acquire", id, key });
      if (signal?.aborted) abort();
    });
  };

  grant(id: string): void { this.pending.get(id)?.(); }
}
