import { createHash } from "node:crypto";

export type LegacyProjectionProvider = {
  id: string;
  name: string;
  base_url: string;
  api: string;
  models: string[];
  reasoning?: boolean;
  context_window?: number;
  model_hints?: Record<string, { context_window?: number; reasoning?: boolean; thinking_levels?: string[] }>;
  api_key?: string;
};

export type LegacyProjectionResult = {
  providers: Record<string, Record<string, unknown>>;
  runtimeSecrets: Record<string, string>;
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "custom-api";
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function runtimeSecretName(namespace: string): string {
  return `PI_RUNTIME_CREDENTIAL_${createHash("sha256").update(namespace).digest("hex").slice(0, 8).toUpperCase()}`;
}

/** Compatibility reader for installations that have not called the resource
 * migration yet. It is intentionally isolated from the runtime launcher and
 * is deleted with the legacy adapter gate. */
export function projectLegacyCustomProviders(settings: Record<string, unknown>): LegacyProjectionResult {
  const providers: Record<string, Record<string, unknown>> = {};
  const runtimeSecrets: Record<string, string> = {};
  const raw = Array.isArray(settings.custom_providers) ? settings.custom_providers : [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const legacyId = slug(String(source.id ?? source.name ?? "custom-api"));
    const providerId = `custom-${legacyId}`;
    const models = Array.isArray(source.models) ? source.models.map(String).filter(Boolean) : [];
    const providerReasoning = typeof source.reasoning === "boolean" ? source.reasoning : undefined;
    const providerContext = positiveInteger(source.context_window) ?? 128000;
    const hints = source.model_hints && typeof source.model_hints === "object" ? source.model_hints as Record<string, { context_window?: number; reasoning?: boolean; thinking_levels?: string[] }> : {};
    const modelDefinitions = models.map((model) => {
      const hint = hints[model] ?? {};
      const reasoning = typeof hint.reasoning === "boolean" ? hint.reasoning : providerReasoning ?? /gpt-5|thinking|reasoning|qwen3|deepseek-r1|deepseek-v4/i.test(model);
      // Keep the legacy projection byte-compatible for old installations;
      // canonical resources use the stricter capability resolver.
      const levels = Array.isArray(hint.thinking_levels) && hint.thinking_levels.length > 0 ? hint.thinking_levels : ["off", "minimal", "low", "medium", "high", "xhigh"];
      return {
        id: model,
        name: model,
        reasoning,
        input: ["text"],
        contextWindow: positiveInteger(hint.context_window) ?? providerContext,
        maxTokens: 16384,
        ...(reasoning ? { thinkingLevelMap: Object.fromEntries(levels.map((level) => [String(level), String(level)])) } : {}),
      };
    });
    const apiKey = typeof source.api_key === "string" ? source.api_key : "";
    const runtimeSecret = apiKey ? runtimeSecretName(`legacy-provider:${legacyId}`) : undefined;
    if (runtimeSecret && apiKey) runtimeSecrets[runtimeSecret] = apiKey;
    providers[providerId] = {
      name: String(source.name ?? "Custom API"),
      baseUrl: String(source.base_url ?? ""),
      api: String(source.api ?? "openai-completions"),
      models: modelDefinitions,
      ...(runtimeSecret ? { apiKey: `$${runtimeSecret}` } : {}),
    };
  }
  return { providers, runtimeSecrets };
}
