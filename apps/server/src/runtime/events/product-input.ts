import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantContent } from "./assistant-content.js";
import { z } from "zod";

const identity = { runId: z.string().min(1), turnId: z.string().optional() };
const message = z.object({ role: z.string() }).passthrough();
const content = z.object({
  source: z.enum(["core", "legacy"]), kind: z.enum(["text", "thinking"]),
  type: z.string(), text: z.string(), snapshot: z.string().optional(), messageId: z.string(), contentIndex: z.string(),
  presentationRole: z.enum(["intermediate", "final"]).optional(),
});
const tool = { ...identity, toolCallId: z.string().min(1), toolName: z.string().min(1) };
/** Worker facts, separate from the public SSE contract and legacy RPC names. */
export const productInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("operation.started"), ...identity }).passthrough(),
  z.object({ type: z.literal("operation.settled"), ...identity, status: z.enum(["completed", "declined", "aborted", "failed"]) }).passthrough(),
  z.object({ type: z.literal("message.started"), ...identity, runId: identity.runId.optional(), message }).passthrough(),
  z.object({ type: z.literal("message.completed"), ...identity, runId: identity.runId.optional(), message }).passthrough(),
  z.object({ type: z.literal("message.updated"), ...identity, runId: identity.runId.optional(), message, content }).passthrough(),
  z.object({ type: z.literal("tool.started"), ...tool, args: z.unknown() }).passthrough(),
  z.object({ type: z.literal("tool.updated"), ...tool, partialResult: z.unknown() }).passthrough(),
  z.object({ type: z.literal("tool.completed"), ...tool, result: z.unknown(), isError: z.boolean() }).passthrough(),
  z.object({ type: z.enum(["compaction.start", "compaction.end", "compaction.error", "retry.start", "retry.end", "retry.update", "model.turn.started"]), ...identity }).passthrough(),
  z.object({ type: z.literal("runtime.error"), message: z.string() }).passthrough(),
  z.object({ type: z.literal("interaction.requested"), id: z.string().min(1), method: z.enum(["input", "confirm"]), title: z.string() }).passthrough(),
  z.object({ type: z.literal("subagent.requested"), id: z.string().min(1), params: z.record(z.string(), z.unknown()), operationId: z.string(), invocationId: z.string() }).passthrough(),
  z.object({ type: z.literal("subagent.cancelled"), id: z.string().min(1) }).passthrough(),
]);
type Identity = { runId: string; turnId?: string };
type MessageIdentity = { runId?: string; message: AgentMessage };
export type ProductInput = (
  | ({ type: "operation.started" } & Identity)
  | ({ type: "operation.settled"; status: "completed" | "declined" | "aborted" | "failed" } & Identity)
  | ({ type: "message.started" | "message.completed" } & MessageIdentity)
  | { type: "message.updated"; runId: string; message: { role: "assistant"; id?: string }; content: AssistantContent }
  | ({ type: "tool.started" | "tool.updated" | "tool.completed"; toolCallId: string; toolName: string } & Identity)
  | ({ type: "compaction.start" | "compaction.end" | "compaction.error" | "retry.start" | "retry.end" | "retry.update" | "model.turn.started" } & Identity)
  | { type: "runtime.error"; message: string; runId?: string }
  | { type: "interaction.requested" | "subagent.requested" | "subagent.cancelled"; id: string }
) & { [key: string]: unknown };
