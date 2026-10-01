import type { RuntimeEvent, RuntimeResult, RuntimeSkillPolicy } from "../agent-runtime-types.js";

export interface AgentRuntimeStartOptions {
  cwd: string;
  sessionId?: string;
  sessionsRoot: string;
  model: { provider: string; modelId: string };
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;
  skillPaths?: string[];
  skillPolicy?: RuntimeSkillPolicy;
  env?: Record<string, string>;
  credentialEnvNames?: string[];
  /** The session service binds events and applies its snapshot before activation. */
  deferActivation?: boolean;
}

export type WorkerCommand =
  | { type: "initialize"; requestId: string; options: AgentRuntimeStartOptions }
  | { type: "command"; requestId: string; command: string; params: Record<string, unknown> }
  | { type: "notification"; requestId: string; notification: string; params: Record<string, unknown> }
  | { type: "shutdown" };

export type WorkerEvent =
  | { type: "ready"; sessionId: string }
  | { type: "result"; requestId: string; result: RuntimeResult }
  | { type: "runtime_event"; event: RuntimeEvent }
  | { type: "fatal"; error: string };
