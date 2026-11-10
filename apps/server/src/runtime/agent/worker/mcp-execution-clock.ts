/** Per-connection active time. Human network approvals pause only their owning
 * connection; cancellation and the host's hard task deadline remain authoritative. */
export class McpExecutionClock {
  private readonly waits = new Map<string, { count: number; since: number; elapsed: number }>();
  private readonly signals = new Map<string, Set<AbortSignal>>();
  private readonly listeners = new Map<string, Set<() => void>>();

  activeNow(id: string): number {
    const now = Date.now(),
      state = this.waits.get(id);
    return now - (state?.elapsed ?? 0) - (state?.count ? now - state.since : 0);
  }

  beginApproval(id: string): () => void {
    let state = this.waits.get(id);
    if (!state) {
      state = { count: 0, since: 0, elapsed: 0 };
      this.waits.set(id, state);
    }
    if (state.count++ === 0) state.since = Date.now();
    this.changed(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--state.count === 0) state.elapsed += Date.now() - state.since;
      this.changed(id);
    };
  }

  approvalSignal(id: string, signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, ...(this.signals.get(id) ?? [])]);
  }

  private changed(id: string): void {
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  async run<T>(
    id: string,
    deadline: number,
    message: string,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let signals = this.signals.get(id);
    if (!signals) {
      signals = new Set();
      this.signals.set(id, signals);
    }
    signals.add(combined);
    let timer: NodeJS.Timeout | undefined;
    let rejectWait!: (error: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectWait = reject;
    });
    const onAbort = () => rejectWait(combined.reason ?? new Error("MCP request cancelled"));
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const remaining = deadline - this.activeNow(id);
      if (remaining <= 0) controller.abort(new Error(message));
      else if (!this.waits.get(id)?.count)
        timer = setTimeout(() => controller.abort(new Error(message)), remaining);
    };
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(id, listeners);
    }
    listeners.add(schedule);
    combined.addEventListener("abort", onAbort, { once: true });
    try {
      schedule();
      return await Promise.race([
        aborted,
        Promise.resolve().then(() => {
          combined.throwIfAborted();
          return operation(combined);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      listeners.delete(schedule);
      if (!listeners.size) this.listeners.delete(id);
      combined.removeEventListener("abort", onAbort);
      signals.delete(combined);
      if (!signals.size) this.signals.delete(id);
      controller.abort(new Error("MCP request finished"));
    }
  }
}
