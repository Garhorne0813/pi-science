export interface RuntimeResult {
  success: boolean;
  code?: string;
  error?: string;
  data?: unknown;
  [key: string]: unknown;
}

export type RuntimeSkillPolicy =
  | { mode: "inherit" }
  | { mode: "none" }
  | { mode: "allowlist"; skills: string[] }
  | { mode: "denylist"; skills: string[] };

export interface RuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export type RuntimeExit = { code: number | null; signal: NodeJS.Signals | null };

/** Temporary Orbit transport hooks used by the existing recovery path. */
export interface LegacyOrbitTransport {
  readonly runtimeIdentity?: { piSessionId: string };
  readonly attachedToHost: boolean;
  readonly lastEventAt: number;
  readonly eventStreamAlive: boolean;
  reconnectEventStream(): Promise<void>;
}

/** The browser event hub and session service depend on this boundary only. */
export interface AgentRuntime {
  readonly sessionId: string;
  readonly cwd: string;
  readonly isClosed: boolean;
  readonly legacyOrbit?: LegacyOrbitTransport;

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
