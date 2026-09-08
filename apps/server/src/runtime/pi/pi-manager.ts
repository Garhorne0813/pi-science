import { PiProcess, type PiProcessOptions, type PiResult } from "./pi-process.js";
import { PiOrbitHost } from "./pi-orbit-host.js";
import { refreshWebRuntimeAllocation, resetWebRuntimeAllocation } from "./pi-runtime-launch.js";

export class PiManager {
  private readonly processes = new Map<string, PiProcess>();
  private readonly pendingStarts = new Map<string, Promise<PiProcess>>();
  private webHost: PiOrbitHost | undefined;
  private webHostStart: Promise<PiOrbitHost> | undefined;

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

  async getCatalog(options: PiProcessOptions): Promise<Awaited<ReturnType<PiOrbitHost["getCatalog"]>>> {
    return (await this.ensureWebHost(options)).getCatalog();
  }
  async recycleWebHost(): Promise<boolean> {
    if (!this.webHost && !this.webHostStart) return false;
    await this.shutdownAll();
    return true;
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(this.pendingStarts.values());
    const processes = [...this.processes.entries()];
    this.processes.clear();
    const host = this.webHost;
    this.webHost = undefined;
    this.webHostStart = undefined;
    if (host) {
      // The host is being torn down anyway: per-runtime dispose would wait up
      // to the full dispose budget on a process that is about to die. Detach
      // the web runtimes (stop their event streams, mark them closed) and kill
      // the host directly instead.
      //
      // Invariant: a manager never mixes web and RPC processes — the mode
      // comes from the process-wide PI_SCIENCE_PI_MODE env. If that ever
      // changes, RPC processes attached to this manager must be shut down
      // individually here (detachFromHost on an RPC process would only mark
      // it closed and leak the OS process).
      for (const [, process] of processes) {
        if (process.attachedToHost) process.detachFromHost();
        else await process.shutdown();
      }
      await host.shutdown();
      return;
    }
    await Promise.all(processes.map(([, process]) => process.shutdown()));
  }

  get activeCount(): number {
    return this.processes.size;
  }

  get hostProcessCount(): number {
    return this.webHost && !this.webHost.isClosed ? 1 : 0;
  }

  get processCount(): number {
    return this.hostProcessCount || this.processes.size;
  }

  private async startOnce(key: string, options: PiProcessOptions): Promise<PiProcess> {
    const process = options.web
      ? await PiProcess.attachWeb(await this.ensureWebHost(options), options)
      : PiProcess.start(options);
    process.once("exit", () => {
      if (this.processes.get(key) === process) this.processes.delete(key);
    });
    this.processes.set(key, process);
    return process;
  }

  private async ensureWebHost(options: PiProcessOptions): Promise<PiOrbitHost> {
    if (this.webHost && !this.webHost.isClosed) return this.webHost;
    if (this.webHostStart) return this.webHostStart;
    const starting = (async () => {
      let hostOptions = options;
      for (let attempt = 0; ; attempt += 1) {
        const host = new PiOrbitHost(hostOptions);
        host.once("exit", () => {
          if (this.webHost === host) this.webHost = undefined;
        });
        try {
          await host.ready();
          this.webHost = host;
          return host;
        } catch (error) {
          await host.shutdown().catch(() => undefined);
          const message = error instanceof Error ? error.message : String(error);
          // Windows may deny a port from its excluded/reserved range with
          // EACCES even though no process is listening on it. Retry a small
          // number of times with a fresh allocation, while preserving the
          // existing EADDRINUSE behavior (the caller still gets a useful
          // failure when another process owns the configured port).
          if (attempt < 2 && /\bEACCES\b|permission denied/i.test(message)) {
            hostOptions = refreshWebRuntimeAllocation(hostOptions);
            continue;
          }
          // The singleton port may be taken by another process (EADDRINUSE),
          // or all permission retries may have failed; forget it so the next
          // attempt allocates a fresh port/token and can self-heal without
          // restarting the control plane.
          resetWebRuntimeAllocation();
          throw error;
        }
      }
    })();
    this.webHostStart = starting;
    try { return await starting; }
    finally {
      if (this.webHostStart === starting) this.webHostStart = undefined;
    }
  }
}

export const piManager = new PiManager();
