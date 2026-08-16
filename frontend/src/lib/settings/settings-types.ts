/** DTOs for the `/api/settings`, `/api/endpoints`, `/api/agent-profiles` and `/api/mcp`
 *  routes. `packages/contracts` is server-owned and carries no settings schema, so the
 *  shapes the settings UI reads live here once instead of once per component file. */

export type ProviderAuthKind = "api_key" | "oauth" | "api_key_or_oauth";
export type ProviderCredentialStatus = "configured" | "connected" | "needs_key" | "needs_login";

export interface ProviderAuthInfo {
  kind: ProviderAuthKind;
  api_key_supported: boolean;
  oauth_supported: boolean;
  login_supported: boolean;
}

export interface Provider {
  id: string;
  name: string;
  models: string[];
  has_key: boolean;
  /** Dynamic pi-ai provider metadata. Absent in legacy API responses, so the
   *  UI falls back to the `has_key`-only behavior when it is missing. */
  auth?: ProviderAuthInfo;
  credential_status?: ProviderCredentialStatus;
  enabled?: boolean;
}

export interface CustomProvider {
  id: string;
  name: string;
  base_url: string;
  api: string;
  models: string[];
  has_key: boolean;
  reasoning?: boolean;
  context_window?: number;
  model_hints?: Record<string, { context_window?: number; reasoning?: boolean; thinking_levels?: string[]; source?: string }>;
}

export interface AvailableModel {
  id: string;
  provider: string;
  model: string;
  label: string;
  custom: boolean;
  reasoning: boolean;
  thinking_levels: string[];
  capability_source: string;
  context_window?: number | null;
}

export interface SettingsConfig {
  api_keys: Record<string, boolean>;
  model: string;
  thinking: string;
  providers: Provider[];
  custom_providers: CustomProvider[];
  available_models: AvailableModel[];
  model_catalog_source?: "pi" | "fallback";
  compaction_enabled: boolean;
  compaction_threshold_percent: number;
  model_context_window?: number | null;
}

export interface ModelEndpoint {
  endpoint_id: string;
  name: string;
  base_url: string;
  protocol: string;
  enabled: boolean;
  health: string;
  data_egress: string;
  error?: string | null;
}

export interface RuntimeExtension {
  id: string;
  name: string;
  description: string;
  installed: boolean;
}

export interface WebProvider {
  id: string;
  has_key: boolean;
  key_source: "web-access" | "environment" | "llm-settings" | null;
  env: string;
}

export interface WebAccessConfig {
  provider: string;
  workflow: string;
  providers: WebProvider[];
}

export interface ProjectSubagent {
  name: string;
  description: string;
  prompt: string;
  model: string;
  thinking: string;
  tools: string;
  system_prompt_mode: "replace" | "append";
  inherit_project_context: boolean;
  inherit_skills: boolean;
  default_context: "fresh" | "fork";
  path?: string;
}

export interface AgentProfile {
  name: string;
  display_name: string;
  description: string;
  read_scope?: string[];
  write_scope?: string[];
  unrestricted?: boolean;
  source: string;
}

export interface McpServer {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  health: string;
  auth: string;
  data_egress: string;
  transport: string;
  tools: Array<{ name: string }>;
  terms_url?: string | null;
  privacy_url?: string | null;
  error?: string | null;
}
