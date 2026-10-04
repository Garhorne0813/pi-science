export interface RuntimeResult<T = unknown> {
  success: boolean;
  code?: string;
  error?: string;
  data?: T;
  [key: string]: unknown;
}

export type RuntimeSkillPolicy =
  | { mode: "inherit" }
  | { mode: "none" }
  | { mode: "allowlist"; skills: string[] }
  | { mode: "denylist"; skills: string[] };

export type RuntimeEvent = import("../events/product-input.js").ProductInput;

export interface AgentRuntime {
  readonly sessionId: string;
  readonly cwd: string;
  readonly isClosed: boolean;

  sendCommand(type: string, params?: Record<string, unknown>): Promise<RuntimeResult>;
  sendNotification(type: string, params?: Record<string, unknown>): Promise<void>;
  getSkills(): Promise<RuntimeResult>;
  setSkillPolicy(policy: RuntimeSkillPolicy): Promise<RuntimeResult>;
  refreshSkills(): Promise<RuntimeResult>;
  on(event: "event" | "stderr" | "malformed" | "exit", listener: (...args: any[]) => void): this;
  shutdown(): Promise<void>;
}

export interface RuntimeEventSource {
  on(event: "event" | "stderr" | "malformed" | "exit", listener: (...args: any[]) => void): unknown;
}
