import type { ModelCapabilities, CapabilitySource } from "@pi-science/contracts";

export const CANONICAL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_SET = new Set<string>(CANONICAL_THINKING_LEVELS);

export const capabilitySourcePriority: Record<CapabilitySource, number> = {
  fallback: 0,
  provider: 1,
  discovery: 2,
  manual: 3,
  runtime: 4,
};

export type CapabilityPatch = Partial<ModelCapabilities> & {
  source?: CapabilitySource;
  verified_at?: string | null;
};

export type ResolvedCapabilities = {
  capabilities: ModelCapabilities;
  capability_source: CapabilitySource;
  verified_at: string | null;
};

export function normalizeThinkingLevels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const entry of value) {
    const level = String(entry ?? "");
    if (!THINKING_LEVEL_SET.has(level)) return null;
    seen.add(level);
  }
  if (seen.size === 0) return null;
  return CANONICAL_THINKING_LEVELS.filter((level) => seen.has(level));
}

export function normalizeContextWindow(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value.replaceAll(",", "")) : Number(value);
  return Number.isInteger(number) && number >= 4096 ? number : null;
}

function normalizePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizePatch(patch: CapabilityPatch): CapabilityPatch {
  const normalized: CapabilityPatch = {};
  if (typeof patch.reasoning === "boolean") normalized.reasoning = patch.reasoning;
  const thinkingLevels = normalizeThinkingLevels(patch.thinking_levels);
  if (thinkingLevels) normalized.thinking_levels = thinkingLevels;
  if (patch.context_window !== undefined) {
    const contextWindow = normalizeContextWindow(patch.context_window);
    if (contextWindow !== null) normalized.context_window = contextWindow;
  }
  if (patch.max_output_tokens !== undefined) {
    const maxOutputTokens = normalizePositive(patch.max_output_tokens);
    if (maxOutputTokens !== null) normalized.max_output_tokens = maxOutputTokens;
  }
  for (const key of ["vision", "tools", "structured_output"] as const) if (typeof patch[key] === "boolean") normalized[key] = patch[key];
  if (patch.source) normalized.source = patch.source;
  if (patch.verified_at !== undefined) normalized.verified_at = patch.verified_at;
  return normalized;
}

function fallbackForModel(modelId: string): CapabilityPatch {
  const reasoning = /thinking|reasoning|qwen3|deepseek-r1|deepseek-v4|o[1-9]|gpt-5/i.test(modelId);
  return { reasoning, thinking_levels: reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"], source: "fallback" };
}

/** Merge fields independently. A runtime context window may improve a manual
 * reasoning hint without erasing it, while a later discovery refresh cannot
 * overwrite a manual field. */
export function resolveCapabilities(modelId: string, patches: CapabilityPatch[] = []): ResolvedCapabilities {
  const inputs = [fallbackForModel(modelId), ...patches];
  const selected: Record<string, { value: unknown; source: CapabilitySource; priority: number; verifiedAt?: string | null }> = {};
  for (const raw of inputs) {
    const patch = normalizePatch(raw);
    const source = patch.source ?? "fallback";
    const priority = capabilitySourcePriority[source];
    for (const key of ["reasoning", "thinking_levels", "context_window", "max_output_tokens", "vision", "tools", "structured_output"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      const previous = selected[key];
      if (!previous || priority >= previous.priority) selected[key] = { value, source, priority, verifiedAt: patch.verified_at };
    }
  }
  const reasoning = selected.reasoning?.value === true;
  const levels = reasoning ? normalizeThinkingLevels(selected.thinking_levels?.value) ?? ["off"] : ["off"];
  const source = [...Object.values(selected)].sort((a, b) => b.priority - a.priority)[0]?.source ?? "fallback";
  const verifiedAt = selected.reasoning?.verifiedAt ?? selected.context_window?.verifiedAt ?? null;
  return {
    capabilities: {
      reasoning,
      thinking_levels: levels,
      context_window: (selected.context_window?.value as number | null | undefined) ?? null,
      max_output_tokens: (selected.max_output_tokens?.value as number | null | undefined) ?? null,
      ...(typeof selected.vision?.value === "boolean" ? { vision: selected.vision.value } : {}),
      ...(typeof selected.tools?.value === "boolean" ? { tools: selected.tools.value } : {}),
      ...(typeof selected.structured_output?.value === "boolean" ? { structured_output: selected.structured_output.value } : {}),
    },
    capability_source: source,
    verified_at: verifiedAt,
  };
}

export function capabilityPatchFromModel(value: {
  capabilities?: Partial<ModelCapabilities>;
  capability_source?: CapabilitySource;
  verified_at?: string | null;
}): CapabilityPatch {
  return { ...(value.capabilities ?? {}), source: value.capability_source, verified_at: value.verified_at };
}
