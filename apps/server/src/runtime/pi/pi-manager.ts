import { PiProcess, type PiProcessOptions, type PiResult } from "./pi-process.js";

/** Owns one Pi runtime process per session. */
export class PiManager {
  private readonly processes = new Map<string, PiProcess>();
  private readonly pendingStarts = new Map<string, Promise<PiProcess>>();

  async start(key: string, options: PiProcessOptions): Promise<PiProcess> {
    const existing = this.processes.get(key);
    if (existing) return existing;
    const pending = this.pendingStarts.get(key);
    if (pending) return pending;
    const started = this.startOnce(key, options);
    this.pendingStarts.set(key, started);
    try { return await started; }
    finally {
      if (this.pendingStarts.get(key) === started) this.pendingStarts.delete(key);
    }
  }

  get(key: string): PiProcess | undefined {
    return this.processes.get(key);
  }

  async sendCommand(key: string, type: string, params: Record<string, unknown> = {}): Promise<PiResult> {
    const process = this.processes.get(key);
    if (!process) return { success: false, code: "not_found", error: "pi process not found" };
    return process.sendCommand(type, params);
  }

  async stop(key: string): Promise<void> {
    const process = this.processes.get(key);
    if (!process) return;
    this.processes.delete(key);
    await process.shutdown();
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(this.pendingStarts.values());
    const processes = [...this.processes.values()];
    this.processes.clear();
    await Promise.all(processes.map((process) => process.shutdown()));
  }

  get activeCount(): number {
    return this.processes.size;
  }

  get processCount(): number {
    return this.processes.size;
  }

  private async startOnce(key: string, options: PiProcessOptions): Promise<PiProcess> {
    const process = PiProcess.start(options);
    process.once("exit", () => {
      if (this.processes.get(key) === process) this.processes.delete(key);
    });
    this.processes.set(key, process);
    return process;
  }
}

export const piManager = new PiManager();
