import { z } from "zod";
import type { CompactionSettings, Entry, LaneSnapshot, OperationResultRecord } from "@earendil-works/pi-agent-core/node";
import type { RuntimeResult } from "../agent-runtime-types.js";

const empty = z.object({}).strict();
const text = z.string().min(1);
const prompt = z.object({ message: z.string().refine((s) => s.trim().length > 0), client_message_id: text.optional() }).strict();
export const skillPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit") }).strict(), z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("allowlist"), skills: z.array(text) }).strict(),
  z.object({ mode: z.literal("denylist"), skills: z.array(text) }).strict(),
]);
export const commandSchemas = {
  activate: empty, get_state: empty, prompt, steer: z.object({ message: text }).strict(), follow_up: z.object({ message: text }).strict(),
  abort: empty, compact: z.object({ customInstructions: z.string().optional() }).strict(),
  configure: z.object({ provider: text, modelId: text, level: z.string().optional() }).strict(),
  set_model: z.object({ provider: text, modelId: text }).strict(), set_thinking_level: z.object({ level: text }).strict(),
  get_available_thinking_levels: empty, get_available_models: empty, get_commands: empty, get_skills: empty,
  set_skill_policy: z.object({ policy: skillPolicySchema }).strict(), refresh_skills: empty,
  get_entries: empty, get_messages: empty, get_last_assistant_text: empty, get_tree: empty,
  fork: z.object({ entryId: text.optional() }).strict(), clone: empty, get_session_stats: empty,
  get_operation_result: z.object({ operationId: text }).strict(), set_session_name: z.object({ name: z.string().optional() }).strict(),
} as const;
export type RuntimeCommandName = keyof typeof commandSchemas;
export type CommandParams<K extends RuntimeCommandName> = z.infer<(typeof commandSchemas)[K]>;
export type RuntimeCommand = { [K in RuntimeCommandName]: { command: K; params: CommandParams<K> } }[RuntimeCommandName];
export interface RuntimeSnapshot {
  sessionId: string; busy: boolean; model: LaneSnapshot["configuration"]["model"];
  thinkingLevel: LaneSnapshot["configuration"]["thinkingLevel"]; activeTools: string[];
  operation: LaneSnapshot["operation"]; queues: LaneSnapshot["queues"]; faulted: boolean;
  lastResult?: LaneSnapshot["lastResult"]; eventSequence: number; runtimeEpoch: string; pendingInteraction?: unknown;
  context_tokens: number | null; context_window: number | null; context_percent: number | null;
  compaction: CompactionSettings; compaction_threshold_percent: number;
}
export type CommandData = {
  activate: undefined; abort: unknown; prompt: undefined; steer: unknown; follow_up: unknown; compact: undefined;
  get_state: RuntimeSnapshot;
  configure: { model: RuntimeSnapshot["model"]; thinkingLevel: RuntimeSnapshot["thinkingLevel"] };
  set_model: CommandData["configure"]; set_thinking_level: CommandData["configure"];
  get_available_thinking_levels: { levels: string[]; model: string }; get_available_models: { models: unknown[] };
  get_commands: { commands: Array<{ name: string; description: string; source: string; group: string }> };
  get_skills: { skills: Array<{ name: string; description: string; filePath: string; enabled: boolean }>; policy: z.infer<typeof skillPolicySchema> };
  set_skill_policy: CommandData["get_skills"]; refresh_skills: CommandData["get_skills"];
  get_entries: { entries: Entry[] }; get_messages: { messages: Array<Extract<Entry, { type: "message" }>> };
  get_last_assistant_text: { text: string }; get_tree: { entries: Array<Pick<Entry, "id" | "parentId" | "type" | "timestamp">> };
  fork: { sessionId: string }; clone: CommandData["fork"]; get_session_stats: LaneSnapshot["stats"];
  get_operation_result: OperationResultRecord | undefined; set_session_name: undefined;
};
export type CommandResult<K extends RuntimeCommandName> = RuntimeResult<CommandData[K]>;
export const resultSchema = z.object({ success: z.boolean(), code: z.string().optional(), error: z.string().optional(), data: z.unknown().optional() }).passthrough();
export const notificationSchemas = {
  extension_ui_response: z.object({ id: text, cancelled: z.boolean().optional(), confirmed: z.boolean().optional(), value: z.unknown().optional() }).strict(),
  subagent_response: z.object({ id: text, result: resultSchema }).strict(),
} as const;
export type RuntimeNotification = { [K in keyof typeof notificationSchemas]: { notification: K; params: z.infer<(typeof notificationSchemas)[K]> } }[keyof typeof notificationSchemas];

export function decodeCommand(command: string, params: unknown): { ok: true; value: RuntimeCommand } | { ok: false; result: RuntimeResult } {
  if (!Object.hasOwn(commandSchemas, command)) return { ok: false, result: { success: false, code: "unsupported_command", error: `unsupported agent command: ${command}` } };
  const name = command as RuntimeCommandName;
  const parsed = commandSchemas[name].safeParse(params);
  if (!parsed.success) {
    const code = ["prompt", "steer", "follow_up"].includes(name) ? "invalid_message" : name === "set_skill_policy" ? "invalid_skill_policy"
      : name === "get_operation_result" ? "invalid_operation" : "invalid_command";
    return { ok: false, result: { success: false, code, error: `invalid parameters for ${name}` } };
  }
  // The correlated union is established by the schema selected above.
  return { ok: true, value: { command: name, params: parsed.data } as RuntimeCommand };
}
export function decodeNotification(notification: string, params: unknown): { ok: true; value: RuntimeNotification } | { ok: false; result: RuntimeResult } {
  if (!Object.hasOwn(notificationSchemas, notification)) return { ok: false, result: { success: false, code: "unsupported_notification", error: `unsupported notification: ${notification}` } };
  const name = notification as keyof typeof notificationSchemas;
  const parsed = notificationSchemas[name].safeParse(params);
  return parsed.success ? { ok: true, value: { notification: name, params: parsed.data } as RuntimeNotification }
    : { ok: false, result: { success: false, code: "invalid_request", error: `invalid parameters for ${name}` } };
}

const modelSchema = z.object({ provider: text, modelId: text }).passthrough();
const nonnegative = z.number().finite().nonnegative();
const operationResultSchema = z.object({ operationId: text, kind: z.string(), status: z.enum(["completed", "declined", "aborted", "failed"]),
  fromTipId: z.string().nullable(), tipId: z.string().nullable(), startedAt: nonnegative, endedAt: nonnegative }).passthrough();
export const runtimeSnapshotSchema = z.object({
  sessionId: text, busy: z.boolean(), model: modelSchema, thinkingLevel: z.string(), activeTools: z.array(z.string()),
  operation: z.object({ id: text, kind: z.string(), status: z.string(), startedAt: nonnegative,
    fromTipId: z.string().nullable(), runningTools: z.array(z.unknown()) }).passthrough().nullable(),
  queues: z.array(z.unknown()), faulted: z.boolean(), lastResult: operationResultSchema.optional(), eventSequence: nonnegative.int(), runtimeEpoch: text,
  context_tokens: nonnegative.nullable(), context_window: nonnegative.nullable(), context_percent: nonnegative.nullable(),
  compaction: z.object({ enabled: z.boolean(), reserveTokens: nonnegative, keepRecentTokens: nonnegative }),
  compaction_threshold_percent: z.number().min(50).max(95),
}).passthrough();
const configResultSchema = z.object({ model: modelSchema, thinkingLevel: z.string() }).passthrough();
const resultDataSchemas: Partial<Record<RuntimeCommandName | "initialize", z.ZodType>> = {
  initialize: z.object({ sessionId: text }), get_state: runtimeSnapshotSchema,
  configure: configResultSchema, set_model: configResultSchema, set_thinking_level: configResultSchema,
  get_operation_result: operationResultSchema.optional(),
  get_messages: z.object({ messages: z.array(z.object({ type: z.literal("message"), message: z.object({ role: z.string() }).passthrough() }).passthrough()) }),
  get_session_stats: z.object({ messageCount: nonnegative, usage: z.object({
    input: nonnegative, output: nonnegative, cacheRead: nonnegative, cacheWrite: nonnegative, totalTokens: nonnegative,
    cost: z.object({ input: nonnegative, output: nonnegative, cacheRead: nonnegative, cacheWrite: nonnegative, total: nonnegative }),
  }) }),
};
/** Validate successful authoritative facts before a caller may treat them as typed data. */
export function validResultData(command: string, result: RuntimeResult): boolean {
  if (!result.success) return true;
  const schema = resultDataSchemas[command as keyof typeof resultDataSchemas];
  return !schema || schema.safeParse(result.data).success;
}
