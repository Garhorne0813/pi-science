import { z } from "zod";

/** Shared contracts for the Provider/Model/Endpoint/Credential/Binding domain.
 *  Secrets are intentionally absent from every resource schema in this file. */

export const providerKindSchema = z.enum(["system", "user"]);
export const providerAdapterSchema = z.enum(["pi-ai", "openai-compatible", "anthropic-compatible", "ollama", "native"]);
export const providerCatalogModeSchema = z.enum(["runtime", "discovery", "manual", "hybrid"]);
export const providerAuthKindSchema = z.enum(["api_key", "oauth", "api_key_or_oauth", "none"]);
export const resourceSourceSchema = z.enum(["pi-ai", "user"]);

export const providerSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  name: z.string().min(1).max(200),
  kind: providerKindSchema,
  adapter: providerAdapterSchema,
  enabled: z.boolean().default(true),
  catalog_mode: providerCatalogModeSchema.default("hybrid"),
  auth_kind: providerAuthKindSchema.default("api_key"),
  source: resourceSourceSchema,
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export const capabilitySourceSchema = z.enum(["runtime", "manual", "discovery", "provider", "fallback"]);
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;

export const modelCapabilitiesSchema = z.object({
  reasoning: z.boolean().default(false),
  thinking_levels: z.array(z.string()).default(["off"]),
  context_window: z.number().int().positive().nullable().default(null),
  max_output_tokens: z.number().int().positive().nullable().default(null),
  vision: z.boolean().optional(),
  tools: z.boolean().optional(),
  structured_output: z.boolean().optional(),
});

export const modelSchema = z.object({
  provider_id: z.string().min(1),
  model_id: z.string().min(1).max(500),
  display_name: z.string().min(1).max(500),
  enabled: z.boolean().default(true),
  capabilities: modelCapabilitiesSchema,
  capability_source: capabilitySourceSchema,
  verified_at: z.string().nullable().optional(),
  discovered_at: z.string().nullable().optional(),
});

export const modelReadSchema = modelSchema.extend({
  id: z.string().min(1),
  available: z.boolean(),
  availability_reason: z.string().optional(),
  routes: z.array(z.object({
    binding_id: z.string().min(1),
    endpoint_id: z.string().min(1),
    health: z.string(),
    priority: z.number().int(),
    api: z.string().optional(),
    model_id: z.string().min(1).optional(),
  })).default([]),
});

export const endpointProtocolSchema = z.enum(["openai", "anthropic", "ollama", "native"]);
export const endpointHealthSchema = z.enum(["unknown", "ready", "degraded", "error", "blocked"]);
export const endpointDataEgressSchema = z.enum(["local", "remote"]);

export const endpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  base_url: z.string().url(),
  protocol: endpointProtocolSchema,
  /** Optional transport variant retained for Pi projection compatibility. */
  api: z.enum(["openai-completions", "openai-responses", "anthropic-messages", "ollama", "native"]).optional(),
  credential_ref: z.string().min(1).nullable(),
  enabled: z.boolean().default(true),
  health: endpointHealthSchema.default("unknown"),
  data_egress: endpointDataEgressSchema.default("remote"),
  /** Set when the endpoint was created as part of a custom-provider
   *  aggregate: aggregate deletion removes exactly the endpoints it owns. */
  owner_provider_id: z.string().min(1).optional(),
  rate_limit: z.object({
    requests_per_minute: z.number().int().positive().optional(),
    tokens_per_minute: z.number().int().positive().optional(),
  }).optional(),
  network_policy: z.object({ allow_private: z.boolean().optional() }).optional(),
  last_checked_at: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export const credentialKindSchema = z.enum(["api_key", "oauth", "none"]);
export const credentialBackendSchema = z.enum(["managed", "environment", "external", "oauth"]);
export const credentialStatusSchema = z.enum(["configured", "connected", "needs_key", "needs_login", "invalid"]);

export const credentialMetadataSchema = z.object({
  id: z.string().min(1),
  kind: credentialKindSchema,
  backend: credentialBackendSchema,
  status: credentialStatusSchema,
  label: z.string().max(200).optional(),
  environment_variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  external_provider: z.string().max(200).optional(),
  external_ref: z.string().max(500).optional(),
  created_at: z.string(),
  updated_at: z.string(),
  last_validated_at: z.string().nullable().optional(),
  owner_provider_id: z.string().min(1).optional(),
});

export const bindingSchema = z.object({
  id: z.string().min(1),
  provider_id: z.string().min(1),
  endpoint_id: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().nonnegative().default(100),
  model_allowlist: z.array(z.string().min(1)).optional(),
  model_aliases: z.record(z.string(), z.string()).optional(),
  headers_policy: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export const resolvedRouteSchema = z.object({
  binding_id: z.string().min(1),
  provider_id: z.string().min(1),
  endpoint_id: z.string().min(1),
  base_url: z.string().url(),
  protocol: endpointProtocolSchema,
  api: z.string().optional(),
  model_id: z.string().min(1),
  priority: z.number().int(),
  health: endpointHealthSchema,
  credential_ref: z.string().nullable(),
  unverified: z.boolean().default(false),
});

export const resolvedRuntimeModelSchema = z.object({
  id: z.string().min(1),
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  display_name: z.string().min(1),
  available: z.boolean(),
  capabilities: modelCapabilitiesSchema,
  capability_source: capabilitySourceSchema,
  routes: z.array(resolvedRouteSchema).default([]),
  availability_reason: z.string().optional(),
});

export const resolvedRuntimeProviderSchema = z.object({
  runtime_provider_id: z.string().min(1),
  provider_id: z.string().min(1),
  display_name: z.string().min(1),
  base_url: z.string().optional(),
  api: z.string().min(1),
  models: z.array(resolvedRuntimeModelSchema),
  credential_env: z.string().optional(),
});

export const createProviderRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  adapter: providerAdapterSchema.default("openai-compatible"),
  catalog_mode: providerCatalogModeSchema.default("hybrid"),
  auth_kind: providerAuthKindSchema.default("api_key"),
  enabled: z.boolean().default(true),
});

export const updateProviderRequestSchema = createProviderRequestSchema.partial().omit({ id: true });

export const createEndpointRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  base_url: z.string().min(1),
  protocol: endpointProtocolSchema,
  api: z.enum(["openai-completions", "openai-responses", "anthropic-messages", "ollama", "native"]).optional(),
  credential_ref: z.string().min(1).nullable().optional(),
  enabled: z.boolean().default(true),
  data_egress: endpointDataEgressSchema.default("remote"),
  owner_provider_id: z.string().min(1).optional(),
  rate_limit: endpointSchema.shape.rate_limit,
  network_policy: endpointSchema.shape.network_policy,
});

export const updateEndpointRequestSchema = createEndpointRequestSchema.partial().omit({ id: true });

export const createBindingRequestSchema = z.object({
  id: z.string().optional(),
  provider_id: z.string().min(1),
  endpoint_id: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().nonnegative().default(100),
  model_allowlist: z.array(z.string().min(1)).optional(),
  model_aliases: z.record(z.string(), z.string()).optional(),
  headers_policy: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const updateBindingRequestSchema = createBindingRequestSchema.partial().omit({ id: true, provider_id: true, endpoint_id: true });

export const createCredentialRequestSchema = z.object({
  id: z.string().optional(),
  kind: credentialKindSchema.default("api_key"),
  backend: credentialBackendSchema.default("managed"),
  label: z.string().max(200).optional(),
  secret: z.string().optional(),
  api_key: z.string().optional(),
  environment_variable: z.string().optional(),
  external_provider: z.string().max(200).optional(),
  external_ref: z.string().max(500).optional(),
  owner_provider_id: z.string().min(1).optional(),
});

export const updateCredentialRequestSchema = createCredentialRequestSchema.partial().omit({ id: true });

export type Provider = z.infer<typeof providerSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
export type ModelRead = z.infer<typeof modelReadSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;
export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>;
export type ProviderEndpointBinding = z.infer<typeof bindingSchema>;
export type ResolvedRoute = z.infer<typeof resolvedRouteSchema>;
export type ResolvedRuntimeModel = z.infer<typeof resolvedRuntimeModelSchema>;
export type ResolvedRuntimeProvider = z.infer<typeof resolvedRuntimeProviderSchema>;
export type CreateProviderRequest = z.infer<typeof createProviderRequestSchema>;
export type UpdateProviderRequest = z.infer<typeof updateProviderRequestSchema>;
export type CreateEndpointRequest = z.infer<typeof createEndpointRequestSchema>;
export type UpdateEndpointRequest = z.infer<typeof updateEndpointRequestSchema>;
export type CreateBindingRequest = z.infer<typeof createBindingRequestSchema>;
export type UpdateBindingRequest = z.infer<typeof updateBindingRequestSchema>;
export type CreateCredentialRequest = z.infer<typeof createCredentialRequestSchema>;
export type UpdateCredentialRequest = z.infer<typeof updateCredentialRequestSchema>;

export const modelResourceStateSchema = z.object({
  schema_version: z.literal(1),
  providers: z.array(providerSchema).default([]),
  models: z.array(modelSchema).default([]),
  endpoints: z.array(endpointSchema).default([]),
  bindings: z.array(bindingSchema).default([]),
  aliases: z.record(z.string(), z.string()).default({}),
  /** Compatibility references for builtin credentials migrated from the old
   * api_keys map. They contain IDs only, never secret values. */
  credential_refs: z.record(z.string(), z.string()).default({}),
  migration: z.object({ version: z.number().int().nonnegative(), completed_at: z.string() }).optional(),
});

export type ModelResourceState = z.infer<typeof modelResourceStateSchema>;

export const modelResourceErrorCodes = [
  "invalid_resource",
  "resource_not_found",
  "resource_in_use",
  "provider_id_conflict",
  "discovery_empty",
  "no_routable_endpoint",
  "endpoint_probe_failed",
  "runtime_reload_failed",
] as const;
export type ModelResourceErrorCode = (typeof modelResourceErrorCodes)[number];
