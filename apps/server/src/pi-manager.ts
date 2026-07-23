import { PiProcess, type PiProcessOptions, type PiResult } from "./pi-process.js";

export class PiManager {
  private readonly processes = new Map<string, PiProcess>();

  start(key: string, options: PiProcessOptions): PiProcess {
    const existing = this.processes.get(key);
    if (existing) return existing;
    const process = PiProcess.start(options);
    process.once("exit", () => {
      if (this.processes.get(key) === process) this.processes.delete(key);
    });
    this.processes.set(key, process);
    return process;
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
    const processes = [...this.processes.entries()];
    this.processes.clear();
    await Promise.all(processes.map(([, process]) => process.shutdown()));
  }

  get activeCount(): number {
    return this.processes.size;
  }
}

export const piManager = new PiManager();
