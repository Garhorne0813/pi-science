import type { ProgressAppearance } from "@pi-science/contracts";

/** Response types for the settings configuration endpoint. */

export type ProviderAuthKind = "api_key" | "oauth" | "api_key_or_oauth" | "none";
export type ProviderCredentialStatus = "configured" | "connected" | "needs_key" | "needs_login" | "invalid";

/** How an inline citation reads in the answer body: the document's own number,
 *  or the identifier the model wrote. `number` is the default. */
export type CitationInlineStyle = "number" | "identifier";

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
  custom?: boolean;
  /** Runtime catalog authentication metadata. Absent in legacy API responses,
   *  so the UI falls back to the `has_key`-only behavior when it is missing. */
  auth?: ProviderAuthInfo;
  credential_status?: ProviderCredentialStatus;
  enabled?: boolean;
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
  max_output_tokens?: number | null;
  vision?: boolean;
  tools?: boolean;
  structured_output?: boolean;
  input_formats?: string[];
  context_window?: number | null;
}

export interface SettingsConfig {
  api_keys: Record<string, boolean>;
  model: string;
  thinking: string;
  unavailable_model?: string | null;
  providers: Provider[];
  available_models: AvailableModel[];
  model_catalog_source?: "pi" | "fallback";
  compaction_enabled: boolean;
  /** Effective automatic citation verification on every settled turn: on when
   *  the stored key is absent, otherwise the stored boolean. */
  citation_auto_verify?: boolean;
  /** Effective inline citation style: `number` when the stored key is absent. */
  citation_inline_style?: CitationInlineStyle;
  compaction_threshold_percent: number;
  model_context_window?: number | null;
  model_context_window_override?: { model: string; context_window: number } | null;
  progress_appearance?: ProgressAppearance;
  model_max_output_tokens?: number | null;
}

/** Read-only file inventory; the Core dispatcher loads these definitions per invocation. */
export interface ProjectSubagent {
  name: string;
  path: string;
}


