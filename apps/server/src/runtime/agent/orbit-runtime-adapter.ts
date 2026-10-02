import type { AgentRuntime, RuntimeResult, RuntimeSkillPolicy } from "./agent-runtime-types.js";
import type { PiProcess } from "../pi/pi-process.js";

/** Keeps the Orbit-specific transport outside the runtime API. */
export class OrbitRuntimeAdapter implements AgentRuntime {
  constructor(readonly process: PiProcess, readonly cwd: string) {}

  get sessionId(): string { return this.process.runtimeIdentity?.piSessionId ?? ""; }
  get isClosed(): boolean { return this.process.isClosed; }
  get legacyOrbit(): PiProcess { return this.process; }

  async sendCommand(type: string, params?: Record<string, unknown>): Promise<RuntimeResult> {
    const result = await this.process.sendCommand(type, params);
    return { ...result, success: result.success === true };
  }

  sendNotification(type: string, params?: Record<string, unknown>): Promise<void> {
    return this.process.sendNotification(type, params);
  }

  async getSkills(): Promise<RuntimeResult> {
    const result = await this.process.runtimeSkills();
    return { ...result, success: result.success === true };
  }

  async setSkillPolicy(policy: RuntimeSkillPolicy): Promise<RuntimeResult> {
    const result = await this.process.setRuntimeSkillPolicy(policy);
    return { ...result, success: result.success === true };
  }

  async refreshSkills(): Promise<RuntimeResult> {
    const result = await this.process.refreshRuntimeSkills();
    return { ...result, success: result.success === true };
  }

  on(event: "event" | "stderr" | "malformed" | "exit", listener: (...args: any[]) => void): this {
    this.process.on(event, listener);
    return this;
  }

  shutdown(): Promise<void> { return this.process.shutdown(); }
}
