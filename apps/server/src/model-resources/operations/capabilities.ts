import { normalizeContextWindow, normalizeThinkingLevels, type CapabilityPatch } from "../capability-resolver.js";

export const CONTEXT_KEYS = new Set(["context_window", "context_length", "max_model_len", "max_context_length", "max_position_embeddings", "contextwindow"]);

export const MAX_OUTPUT_KEYS = new Set(["max_output_tokens", "max_completion_tokens"]);

export const THINKING_LEVEL_SET = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function capabilityPatchFromPayload(value: unknown, protocol?: string): CapabilityPatch {
  const patch: CapabilityPatch = {};
  const visit = (current: unknown, depth: number): void => {
    if (depth > 5 || current === null || current === undefined) return;
    if (Array.isArray(current)) { for (const item of current.slice(0, 100)) visit(item, depth + 1); return; }
    if (typeof current !== "object") return;
    for (const [rawKey, child] of Object.entries(current as Record<string, unknown>)) {
      const key = rawKey.toLowerCase();
      if (CONTEXT_KEYS.has(key) && patch.context_window === undefined) {
        const context = normalizeContextWindow(child);
        if (context) patch.context_window = context;
      }
      if (MAX_OUTPUT_KEYS.has(key) && patch.max_output_tokens === undefined) {
        const maxOutput = Number(child);
        if (Number.isInteger(maxOutput) && maxOutput > 0) patch.max_output_tokens = maxOutput;
      }
      if ((key === "reasoning" || key === "supports_reasoning") && typeof child === "boolean" && patch.reasoning === undefined) patch.reasoning = child;
      if ((key === "thinking_levels" || key === "supported_thinking_levels") && Array.isArray(child) && patch.thinking_levels === undefined) {
        const levels = normalizeThinkingLevels(child.filter((level) => THINKING_LEVEL_SET.has(String(level))));
        if (levels) patch.thinking_levels = levels;
      }
      if (key === "thinkinglevelmap" && child && typeof child === "object" && patch.thinking_levels === undefined) {
        const levels = normalizeThinkingLevels(Object.entries(child as Record<string, unknown>).filter(([, mapped]) => mapped !== null).map(([level]) => level));
        if (levels) patch.thinking_levels = levels;
      }
      if ((key === "vision" || key === "supports_vision") && typeof child === "boolean" && patch.vision === undefined) patch.vision = child;
      if ((key === "tools" || key === "supports_tools") && typeof child === "boolean" && patch.tools === undefined) patch.tools = child;
      if ((key === "structured_output" || key === "supports_structured_output") && typeof child === "boolean" && patch.structured_output === undefined) patch.structured_output = child;
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (protocol === "anthropic" && value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
    // max_input_tokens is an input budget, not input + output. Do not add limits.
    patch.context_window = positive(raw.context_window) ?? positive(raw.max_input_tokens) ?? patch.context_window;
    patch.max_output_tokens = positive(raw.max_tokens) ?? patch.max_output_tokens;
    const capabilities = raw.capabilities as Record<string, { supported?: unknown }> | undefined;
    if (typeof capabilities?.image_input?.supported === "boolean") patch.vision = capabilities.image_input.supported;
    if (typeof capabilities?.thinking?.supported === "boolean") patch.reasoning = capabilities.thinking.supported;
    for (const key of Object.keys(patch) as Array<keyof CapabilityPatch>) if (patch[key] === undefined) delete patch[key];
  }
  return patch;
}

export function manualCapabilityPatch(body: Record<string, unknown>): CapabilityPatch {
  const source = body.capabilities && typeof body.capabilities === "object" && !Array.isArray(body.capabilities)
    ? body.capabilities as Record<string, unknown>
    : body;
  const patch: CapabilityPatch = { source: "manual" };
  if (typeof source.reasoning === "boolean") patch.reasoning = source.reasoning;
  const levels = normalizeThinkingLevels(source.thinking_levels);
  if (levels) patch.thinking_levels = levels;
  if (source.context_window !== undefined) patch.context_window = normalizeContextWindow(source.context_window);
  const maxOutput = Number(source.max_output_tokens);
  if (source.max_output_tokens !== undefined && Number.isInteger(maxOutput) && maxOutput > 0) patch.max_output_tokens = maxOutput;
  for (const key of ["vision", "tools", "structured_output"] as const) if (typeof source[key] === "boolean") patch[key] = source[key] as boolean;
  return patch;
}
