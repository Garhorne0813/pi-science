import { z } from "zod";

export const mcpConnectorNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "use lowercase letters, digits, and hyphens");
export const mcpConnectorSourceSchema = z.enum(["builtin", "custom", "imported"]);
export const mcpTransportSchema = z.enum(["stdio", "streamable_http", "sse", "socket"]);
export const mcpApprovalModeSchema = z.enum(["ask", "custom", "allow_all"]);
export const mcpToolDecisionSchema = z.enum(["allow", "ask", "deny"]);
export const mcpConfigStateSchema = z.enum(["valid", "invalid"]);
export const mcpAuthStateSchema = z.enum(["not-required", "configured", "needs-auth", "expired", "error"]);
export const mcpRuntimeStateSchema = z.enum(["unknown", "checking", "ready", "connecting", "connected", "error", "disabled"]);

export const mcpEnvironmentBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string().max(8192) }),
  z.object({ kind: z.literal("environment"), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
  z.object({ kind: z.literal("credential"), credential_ref: z.string().min(1).max(200) }),
]);

export const mcpRuntimeConfigSchema = z.object({
  cwd: z.string().max(2048).nullish(),
  lifecycle: z.enum(["lazy", "eager", "keep-alive", "lazy-keep-alive"]).default("lazy"),
  idle_timeout_minutes: z.number().nonnegative().max(1440).nullish(),
  request_timeout_ms: z.number().int().positive().max(300_000).nullish(),
  expose_resources: z.boolean().default(true),
  include_tools: z.array(z.string().min(1).max(255)).max(500).default([]),
  exclude_tools: z.array(z.string().min(1).max(255)).max(500).default([]),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), mcpEnvironmentBindingSchema).default({}),
  headers: z.record(z.string().min(1).max(200), mcpEnvironmentBindingSchema).default({}),
  auth: z.enum(["auto", "none", "oauth", "bearer"]).default("auto"),
  oauth_client_id: z.string().max(255).nullish(),
  oauth_scope: z.string().max(1024).nullish(),
  allow_private: z.boolean().default(false),
  terms_url: z.string().url().nullish(),
  privacy_url: z.string().url().nullish(),
});

const mcpConnectorInputSchema = z.object({
  name: mcpConnectorNameSchema,
  display_name: z.string().min(1).max(120),
  description: z.string().max(1024).default(""),
  transport: mcpTransportSchema,
  endpoint_url: z.string().url().nullish(),
  command: z.string().min(1).max(2048).nullish(),
  args: z.array(z.string().max(8192)).max(200).default([]),
  socket_path: z.string().min(1).max(2048).nullish(),
  runtime_config: mcpRuntimeConfigSchema,
  credential_ref: z.string().min(1).max(200).nullish(),
  enabled: z.boolean().default(false),
});

function validateConnectorShape(value: z.infer<typeof mcpConnectorInputSchema>, context: z.RefinementCtx): void {
  const remote = value.transport === "streamable_http" || value.transport === "sse";
  if (remote !== Boolean(value.endpoint_url)) context.addIssue({ code: "custom", path: ["endpoint_url"], message: remote ? "endpoint_url is required" : "endpoint_url is only valid for remote transports" });
  if ((value.transport === "stdio") !== Boolean(value.command)) context.addIssue({ code: "custom", path: ["command"], message: value.transport === "stdio" ? "command is required" : "command is only valid for stdio" });
  if ((value.transport === "socket") !== Boolean(value.socket_path)) context.addIssue({ code: "custom", path: ["socket_path"], message: value.transport === "socket" ? "socket_path is required" : "socket_path is only valid for socket" });
}

export const mcpConnectorCreateSchema = mcpConnectorInputSchema.superRefine(validateConnectorShape);
export const mcpConnectorUpdateSchema = mcpConnectorInputSchema.omit({ enabled: true }).partial().extend({ revision: z.number().int().positive() });

export const mcpConnectorSettingsSchema = z.object({
  connector_id: z.string().min(1),
  enabled: z.boolean(),
  include_tools: z.array(z.string()).default([]),
  exclude_tools: z.array(z.string()).default([]),
  approval_mode: mcpApprovalModeSchema,
  revision: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});

export const mcpConnectorSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  include_tools: z.array(z.string().min(1).max(255)).max(500).default([]),
  exclude_tools: z.array(z.string().min(1).max(255)).max(500).default([]),
  approval_mode: mcpApprovalModeSchema.default("ask"),
  revision: z.number().int().positive().optional(),
});

export const mcpToolSummarySchema = z.object({
  name: z.string().min(1),
  title: z.string().nullish(),
  description: z.string().nullish(),
  read_only: z.boolean().nullish(),
  decision: mcpToolDecisionSchema.default("ask"),
});

export const mcpConnectorSchema = z.object({
  connector_id: z.string().min(1),
  name: mcpConnectorNameSchema,
  display_name: z.string(),
  description: z.string(),
  source: mcpConnectorSourceSchema,
  transport: mcpTransportSchema,
  endpoint_url: z.string().nullish(),
  command: z.string().nullish(),
  args: z.array(z.string()),
  socket_path: z.string().nullish(),
  runtime_config: mcpRuntimeConfigSchema,
  credential_ref: z.string().nullish(),
  revision: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  settings: mcpConnectorSettingsSchema,
  config_state: mcpConfigStateSchema,
  auth_state: mcpAuthStateSchema,
  runtime_state: mcpRuntimeStateSchema,
  tool_count: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

export const mcpConnectorListSchema = z.object({ connectors: z.array(mcpConnectorSchema) });
export const mcpToolGrantUpdateSchema = z.object({ decision: mcpToolDecisionSchema });
export const mcpProbeResultSchema = z.object({
  connector_id: z.string(),
  runtime_state: mcpRuntimeStateSchema,
  auth_state: mcpAuthStateSchema,
  error_code: z.string().nullable(),
  error: z.string().nullable(),
  tools: z.array(mcpToolSummarySchema),
  checked_at: z.number().int().nonnegative(),
});

export type McpConnectorCreate = z.infer<typeof mcpConnectorCreateSchema>;
export type McpConnectorUpdate = z.infer<typeof mcpConnectorUpdateSchema>;
export type McpConnector = z.infer<typeof mcpConnectorSchema>;
export type McpConnectorSettings = z.infer<typeof mcpConnectorSettingsSchema>;
export type McpConnectorSettingsUpdate = z.infer<typeof mcpConnectorSettingsUpdateSchema>;
export type McpRuntimeConfig = z.infer<typeof mcpRuntimeConfigSchema>;
export type McpToolSummary = z.infer<typeof mcpToolSummarySchema>;
export type McpProbeResult = z.infer<typeof mcpProbeResultSchema>;
