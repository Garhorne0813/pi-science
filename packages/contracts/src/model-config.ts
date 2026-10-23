import { z } from "zod";

// Explicit Pi 0.99.2 subset. No shell commands, ambient auth, inline keys or 1.2 fields.
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine((value) => !["constructor", "prototype", "__proto__"].includes(value));
// Protocol negotiation only. Free-form/custom authentication headers belong to
// CredentialStore integrations, never this browser-readable configuration.
const headerValues: Record<string, RegExp> = {
  "accept": /^(application\/json|text\/event-stream)(,\s*(application\/json|text\/event-stream))*$/i,
  "content-type": /^application\/json$/i,
  "anthropic-version": /^\d{4}-\d{2}-\d{2}$/,
  "anthropic-beta": /^[a-z][a-z-]*-\d{4}-\d{2}-\d{2}(,\s*[a-z][a-z-]*-\d{4}-\d{2}-\d{2})*$/,
};
const headers = z.record(z.string(), z.string().max(1000)).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [key, content] of Object.entries(value)) {
    const name = key.toLowerCase(), rule = Object.hasOwn(headerValues, name) ? headerValues[name] : undefined;
    if (!rule?.test(content) || /[\r\n]/.test(content) || seen.has(name)) ctx.addIssue({ code: "custom", path: [key], message: "Unsupported non-authentication header" });
    seen.add(name);
  }
});
// Runtime fallback only: discovery leaves an undeclared window absent.
// Settings labels this default rather than presenting it as a provider fact.
export const DEFAULT_MODEL_CONTEXT_WINDOW = 1_000_000;
export const modelCapabilityFields = ["contextWindow", "maxTokens", "input", "reasoning", "thinkingLevelMap"] as const;
export type ModelCapabilityField = typeof modelCapabilityFields[number];
export type ModelCapabilitySource = "declared" | "user_override" | "default" | "unknown";
export type ModelCapabilitySources = Record<ModelCapabilityField, ModelCapabilitySource>;
export const modelConfigApiSchema = z.enum(["openai-completions", "openai-responses", "anthropic-messages"]);
export const configuredModelSchema = z.object({
  id: z.string().min(1).max(500), name: z.string().min(1).max(500).optional(),
  /** Ownership of discovery fields; absent metadata on older files is deliberately unknown. */
  discoveredFields: z.array(z.enum(modelCapabilityFields)).optional(),
  thinkingLevelMap: z.object({ off: z.union([z.string(), z.null()]).optional(), minimal: z.union([z.string(), z.null()]).optional(), low: z.union([z.string(), z.null()]).optional(), medium: z.union([z.string(), z.null()]).optional(), high: z.union([z.string(), z.null()]).optional(), xhigh: z.union([z.string(), z.null()]).optional(), max: z.union([z.string(), z.null()]).optional() }).strict().optional(),
  reasoning: z.boolean().optional(), input: z.array(z.enum(["text", "image"])).min(1).optional(),
  contextWindow: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional(),
  cost: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative() }).strict().optional(),
  headers: headers.optional(),
}).strict();
export const providerConfigSchema = z.object({
  name: z.string().min(1).max(200).optional(), baseUrl: z.string().url().refine((raw) => { const url = new URL(raw); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }).optional(),
  api: modelConfigApiSchema.optional(), headers: headers.optional(),
  models: z.array(configuredModelSchema).max(10000).optional(),
  modelOverrides: z.record(z.string().min(1), configuredModelSchema.omit({ id: true, discoveredFields: true })).optional(),
}).strict().superRefine((value, ctx) => {
  const ids = value.models?.map((model) => model.id) ?? [];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Duplicate model IDs" });
});
export const modelConfigSchema = z.object({ providers: z.record(id, providerConfigSchema).default(() => ({})) }).strict();
export const modelConfigBackendSchema = z.literal("pi_ai_v1");
export const modelConfigSnapshotSchema = z.object({
  schema_version: z.literal(1).default(1), revision: z.number().int().nonnegative().default(0),
  config: modelConfigSchema.default(() => ({ providers: {} })),
  credential_refs: z.record(id, z.string().min(1)).default(() => ({})),
  keyless_providers: z.array(id).default(() => []), legacy_providers: z.array(id).max(0, "Legacy adapters are no longer supported; import or reconfigure explicitly").default(() => []),
  aliases: z.record(z.string(), z.string()).default(() => ({})),
}).strict();
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export function modelCapabilitySources(config: ProviderConfig | undefined, id: string, builtin = false): ModelCapabilitySources {
  const declared = config?.models?.find((model) => model.id === id), override = config?.modelOverrides?.[id];
  return Object.fromEntries(modelCapabilityFields.map((key) => [key, override?.[key] !== undefined ? "user_override"
    : declared?.[key] !== undefined ? declared.discoveredFields?.includes(key) ? "declared" : "unknown" : builtin ? "declared" : "default"])) as ModelCapabilitySources;
}
export type ModelConfigSnapshot = z.infer<typeof modelConfigSnapshotSchema>;
export type ModelConfigBackend = z.infer<typeof modelConfigBackendSchema>;
export type ProviderConfigView = {
  id: string; revision: number; config: ProviderConfig | null; legacy: boolean; editable: boolean;
  configured: boolean;
  authentication: { configured?: boolean; source: "managed" | "environment" | "keyless" | "oauth" | "unconfigured" | "unsupported"; resolved: boolean; environment_variable?: string; restart_required?: boolean; oauth?: { expires_at: number | null; status: "authorized" | "expired" | "invalid"; account: string | null; plan: string | null } };
};

export type ProviderAuthCapabilities = { api_key: boolean; environment: boolean; keyless: boolean; subscription: boolean };

export type ModelOAuthPrompt = {
  id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
};
export type ModelOAuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "info" | "progress"; message: string; links?: Array<{ url: string; label?: string }> };
export type ModelOAuthSessionView = {
  id: string; provider_id: string; status: "authorizing" | "succeeded" | "failed" | "cancelled" | "expired";
  expires_at: number; events: ModelOAuthEvent[]; prompt?: ModelOAuthPrompt;
  error_code?: "oauth_login_failed" | "revision_conflict" | "oauth_cancelled" | "oauth_timeout";
  runtime?: "published" | "reload_pending";
};
