import { z } from "zod";

export const piConfigSchema = z.object({
  model: z.string().nullish(),
  provider: z.string().nullish(),
  api_key: z.string().nullish(),
  thinking: z.string().nullish(),
  skills: z.array(z.string()).default([]),
  extensions: z.array(z.string()).default([]),
});

export const createSessionRequestSchema = z.object({
  cwd: z.string().min(1),
  config: piConfigSchema.default({ skills: [], extensions: [] }),
});

export const createSessionResponseSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
});

export const sessionInfoSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

export const sessionStateSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  is_streaming: z.boolean(),
  is_compacting: z.boolean(),
  pending_message_count: z.number().int().nonnegative(),
  model: z.string().nullish(),
  thinking: z.string().nullish(),
});

export const historyMessageSchema = z.object({
  id: z.string().min(1),
  role: z.string(),
  content: z.array(z.record(z.string(), z.unknown())),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  timestamp: z.string().nullish(),
});

export const workspaceInfoSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  session_count: z.number().int().nonnegative().default(0),
  last_modified: z.string().default(""),
});

export const fileListEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  isDir: z.boolean(),
  size: z.number().nonnegative(),
  modified: z.number(),
});

export const tokenUsageSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
}).passthrough();

const textUpdatedEventSchema = z.object({
  type: z.literal("text.updated"),
  sessionId: z.string(),
  partId: z.string(),
  text: z.string(),
});

const toolUpdatedEventSchema = z.object({
  type: z.literal("tool.updated"),
  sessionId: z.string(),
  callId: z.string(),
  tool: z.string(),
  status: z.enum(["running", "done", "error", "waiting-approval"]),
  title: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  partialOutput: z.string().optional(),
  diff: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  childSessionId: z.string().optional(),
});

const sessionIdleEventSchema = z.object({ type: z.literal("session.idle"), sessionId: z.string() });
const sessionErrorEventSchema = z.object({
  type: z.literal("error"),
  sessionId: z.string().optional(),
  message: z.string(),
  terminal: z.boolean().optional(),
});

export const sessionEventSchema = z.discriminatedUnion("type", [
  textUpdatedEventSchema,
  toolUpdatedEventSchema,
  sessionIdleEventSchema,
  sessionErrorEventSchema,
]).and(z.looseObject({}));

export const piRpcCommandSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
}).passthrough();

export const piRpcResponseSchema = z.object({
  id: z.string().min(1),
  success: z.boolean().optional(),
}).passthrough();

export const piRuntimeEventSchema = z.object({
  type: z.string().min(1),
}).passthrough();

export const jobRecordSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["queued", "pending", "running", "succeeded", "failed", "cancelled", "timed_out"]),
  created_at: z.string(),
  updated_at: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

export const artifactManifestSchema = z.object({
  artifact_id: z.string().min(1),
  version: z.number().int().positive(),
  path: z.string().min(1),
  kind: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(16).max(64),
  published_at: z.string(),
}).passthrough();

export const provenanceRecordSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  actor: z.string().min(1),
  created_at: z.string(),
}).passthrough();

export const scientificRuntimeHealthSchema = z.object({
  status: z.literal("ok"),
  active_pi_processes: z.number().int().nonnegative(),
  active_kernels: z.number().int().nonnegative(),
});

export const gatewayHealthSchema = scientificRuntimeHealthSchema.extend({
  service: z.literal("pi-science-server"),
  control_plane: z.literal("node"),
  scientific_runtime: z.literal("ok"),
});

export type GatewayHealth = z.infer<typeof gatewayHealthSchema>;
export type PiConfig = z.infer<typeof piConfigSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type HistoryMessage = z.infer<typeof historyMessageSchema>;
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;
export type FileListEntry = z.infer<typeof fileListEntrySchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type PiRpcCommand = z.infer<typeof piRpcCommandSchema>;
export type PiRpcResponse = z.infer<typeof piRpcResponseSchema>;
export type PiRuntimeEvent = z.infer<typeof piRuntimeEventSchema>;
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;
