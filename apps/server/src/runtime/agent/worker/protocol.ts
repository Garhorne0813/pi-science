import { productInputSchema } from "../../events/product-input.js";
import { z } from "zod";
import { resultSchema, skillPolicySchema, type RuntimeCommand, type RuntimeNotification } from "./command-contract.js";
import type { RuntimeEvent, RuntimeResult, RuntimeSkillPolicy } from "../agent-runtime-types.js";
import type { RuntimeSettings } from "../agent-runtime-settings.js";

export interface AgentRuntimeStartOptions {
  cwd: string;
  sessionId?: string;
  parentSessionId?: string;
  depth?: number;
  allowedTools?: string[];
  sessionsRoot: string;
  model: { provider: string; modelId: string };
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  settings?: RuntimeSettings;
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
  | ({ type: "command"; requestId: string } & RuntimeCommand)
  | ({ type: "notification"; requestId: string } & RuntimeNotification)
  | { type: "shutdown" };

export type WorkerEvent =
  | { type: "ready"; sessionId: string }
  | { type: "result"; requestId: string; result: RuntimeResult }
  | { type: "runtime_event"; event: RuntimeEvent }
  | { type: "fatal"; error: string };

const startOptionsSchema = z.object({
  cwd: z.string().min(1), sessionsRoot: z.string().min(1), sessionId: z.string().min(1).optional(),
  parentSessionId: z.string().optional(), depth: z.number().int().nonnegative().optional(), allowedTools: z.array(z.string()).optional(),
  model: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }).strict(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  settings: z.object({ compaction_enabled: z.boolean().optional(), compaction_threshold_percent: z.number().min(50).max(95).optional(),
    model_context_window_override: z.object({ model: z.string(), context_window: z.number().int().positive() }).optional(),
  }).passthrough().optional(), systemPrompt: z.string().optional(), skillPaths: z.array(z.string()).optional(),
  skillPolicy: skillPolicySchema.optional(), env: z.record(z.string(), z.string()).optional(), credentialEnvNames: z.array(z.string()).optional(),
  deferActivation: z.boolean().optional(),
}).strict();
export const workerRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("initialize"), requestId: z.string().min(1), options: startOptionsSchema }).strict(),
  z.object({ type: z.literal("command"), requestId: z.string().min(1), command: z.string(), params: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal("notification"), requestId: z.string().min(1), notification: z.string(), params: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
]);
export const workerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), sessionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("result"), requestId: z.string().min(1), result: resultSchema }).strict(),
  z.object({ type: z.literal("runtime_event"), event: productInputSchema.and(z.object({ runtime_epoch: z.string().min(1), runtime_sequence: z.number().int().positive() })) }).strict(),
  z.object({ type: z.literal("fatal"), error: z.string() }).strict(),
]);
