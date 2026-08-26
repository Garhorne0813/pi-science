export type ProviderKind = "system" | "user";
export type ProviderAdapter = "pi-ai" | "openai-compatible" | "anthropic-compatible" | "ollama" | "native";
export type ProviderAuthKind = "api_key" | "oauth" | "api_key_or_oauth" | "none";
export type ProviderCatalogMode = "runtime" | "discovery" | "manual" | "hybrid";
export type CredentialBackend = "managed" | "environment" | "external" | "oauth";
export type CredentialStatus = "configured" | "connected" | "needs_key" | "needs_login" | "invalid";

export interface ModelProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  adapter: ProviderAdapter;
  enabled: boolean;
  catalog_mode: ProviderCatalogMode;
  auth_kind: ProviderAuthKind;
  source: "pi-ai" | "user";
  models: string[];
  has_key: boolean;
  credential_status: CredentialStatus;
  routes: number;
}

export interface ModelCapabilities {
  reasoning: boolean;
  thinking_levels: string[];
  context_window: number | null;
  max_output_tokens: number | null;
  vision?: boolean;
  tools?: boolean;
  structured_output?: boolean;
}

export interface ModelRoute {
  binding_id: string;
  endpoint_id: string;
  health: string;
  priority: number;
  model_id?: string;
}

export interface ModelResource {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  enabled: boolean;
  capabilities: ModelCapabilities;
  capability_source: "runtime" | "manual" | "discovery" | "provider" | "fallback";
  verified_at?: string | null;
  discovered_at?: string | null;
  available: boolean;
  availability_reason?: string;
  routes: ModelRoute[];
}

export interface CustomProviderResult {
  provider: ModelProvider;
  endpoint: ModelEndpointResource;
  credential: CredentialMetadata | null;
  binding: ProviderEndpointBinding;
  discovery?: { model_count: number };
  discovery_error?: string;
}

export interface ModelEndpointResource {
  id: string;
  endpoint_id?: string;
  name: string;
  base_url: string;
  protocol: "openai" | "anthropic" | "ollama" | "native" | string;
  credential_ref: string | null;
  secret_ref?: string | null;
  enabled: boolean;
  health: "unknown" | "ready" | "degraded" | "error" | "blocked" | string;
  data_egress: "local" | "remote" | string;
  last_checked_at?: string | null;
  last_error?: string | null;
  error?: string | null;
}

export interface ProviderEndpointBinding {
  id: string;
  provider_id: string;
  endpoint_id: string;
  enabled: boolean;
  priority: number;
  model_allowlist?: string[];
  model_aliases?: Record<string, string>;
  headers_policy?: Record<string, string>;
  metadata?: Record<string, string>;
}

export interface CredentialMetadata {
  id: string;
  kind: "api_key" | "oauth" | "none";
  backend: CredentialBackend;
  status: CredentialStatus;
  label?: string;
  environment_variable?: string;
  external_provider?: string;
  external_ref?: string;
  created_at: string;
  updated_at: string;
  last_validated_at?: string | null;
}

export interface ModelPreferences {
  default_model: string | null;
  thinking: string;
  compaction_enabled: boolean;
  compaction_threshold_percent: number;
}
