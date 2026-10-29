/** FIFO admission for permission checks and human decisions, never tool execution. */
export class ApprovalQueue {
  private readonly queues = new Map<string, Array<() => void>>();
  private readonly holds = new Map<string, number>();

  /** A service-side commit outlives its worker; do not admit the next ask mid-save. */
  hold(key: string): () => void {
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.holds.get(key)! - 1;
      if (remaining) this.holds.set(key, remaining);
      else { this.holds.delete(key); this.queues.get(key)?.[0]?.(); }
    };
  }

  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(key) ?? [];
      this.queues.set(key, queue);
      let released = false;
      const remove = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", abort);
        const index = queue.indexOf(admit);
        if (index >= 0) queue.splice(index, 1);
        if (!queue.length) this.queues.delete(key);
        else if (index === 0 && !this.holds.has(key)) queue[0]!();
      };
      const abort = () => { remove(); reject(signal?.reason ?? new Error("Approval cancelled")); };
      const admit = () => {
        signal?.removeEventListener("abort", abort);
        resolve(remove);
      };
      queue.push(admit);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else if (queue.length === 1 && !this.holds.has(key)) admit();
    });
  }
}

/** Shared by every app-owned worker in this control-plane process. */
export const runtimeApprovalQueue = new ApprovalQueue();
export type AcquireApproval = (key: string, signal?: AbortSignal) => Promise<() => void>;
