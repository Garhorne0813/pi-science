import { modelCapabilityFields, type ModelCapabilityField, type ProviderConfig, type ProviderView } from "@pi-science/contracts";
import type { DiscoveredModel } from "./useModelDiscovery";

export type ModelView = {
  id: string;
  name: string;
  vendor?: string;
  reasoning: boolean;
  inputFormats: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  vision?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  thinkingLevels: string[];
  source?: string;
  available?: boolean;
  reason?: string;
};

export type Service = {
  id: string;
  name: string;
  status: ProviderView["status"];
  models: ModelView[];
  custom: boolean;
  auth?: ProviderView["auth"];
  view: ProviderView;
  provider?: Pick<ProviderView, "id" | "name">;
};

/** Adapt presentation fields only: availability and actions are backend facts. */
export function buildServices(providers: ProviderView[]): Service[] {
  return providers.map((view) => ({
    id: view.id, name: view.name, custom: view.source === "user", status: view.status,
    auth: view.auth, provider: { id: view.id, name: view.name }, view,
    models: view.models.map((model) => ({ id: model.id, name: shortModelName(model.display_name, model.model_id), reasoning: model.capabilities.reasoning,
      inputFormats: model.input_formats ?? [], contextWindow: model.capabilities.context_window, maxOutputTokens: model.capabilities.max_output_tokens,
      vision: model.capabilities.vision, tools: model.capabilities.tools, structuredOutput: model.capabilities.structured_output,
      thinkingLevels: model.capabilities.thinking_levels, source: model.capability_source, available: model.available, reason: model.availability_reason })),
  }));
}

export function shortModelName(label: string, model: string) {
  const separator = label.indexOf("·");
  return separator >= 0 ? label.slice(separator + 1).trim() || model : label || model;
}

export function formatContext(value: number | null) {
  if (!value) return "—";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

/** Capabilities the user corrected in the discovery list. Absent keys stay undeclared. */
export type ModelConfigEdits = { contextWindow?: number | null; maxTokens?: number | null; input?: Array<"text" | "image"> | null; reasoning?: boolean | null };
export type LegacyDiscoveryPolicy = "preserve" | "replace";
export type DiscoveryConflict = { id: string; field: ModelCapabilityField; current: unknown; discovered: unknown };
type ConfiguredModel = NonNullable<ProviderConfig["models"]>[number];
type Override = NonNullable<ProviderConfig["modelOverrides"]>[string];
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every((key) => Object.hasOwn(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

/** Maps the capabilities a provider advertised during discovery onto the configuration
 *  schema without inserting defaults or user corrections. Only explicitly reported
 *  thinking levels are declarations; generated runtime maps stay out of this layer. */
export function modelConfigFromDiscovery(model?: DiscoveredModel): Omit<ConfiguredModel, "id"> {
  const capabilities = model?.capabilities ?? {};
  const reasoning = capabilities.reasoning;
  const contextWindow = capabilities.context_window;
  const maxTokens = capabilities.max_output_tokens;
  const input = capabilities.vision === undefined ? undefined : capabilities.vision ? ["text", "image"] as Array<"text" | "image"> : ["text"] as Array<"text" | "image">;
  const patch: Omit<ConfiguredModel, "id"> = {
    ...(model?.display_name && model.display_name !== model.id ? { name: model.display_name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(input ? { input } : {}),
    ...(reasoning && capabilities.thinking_levels ? { thinkingLevelMap: Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, capabilities.thinking_levels!.includes(level) ? level : null])) } : {}),
  };
  const fields = modelCapabilityFields.filter((key) => patch[key] !== undefined);
  return { ...patch, ...(fields.length ? { discoveredFields: fields } : {}) };
}

export function applyModelEdits(original: Override = {}, edits: ModelConfigEdits = {}): Override {
  const next = { ...original };
  for (const key of ["contextWindow", "maxTokens", "input", "reasoning"] as const) {
    const value = edits[key];
    if (value === null) delete next[key];
    else if (value !== undefined) Object.assign(next, { [key]: value });
  }
  if (edits.reasoning === null || edits.reasoning === false) delete next.thinkingLevelMap;
  if (edits.reasoning === true) next.thinkingLevelMap = { ...next.thinkingLevelMap, xhigh: "high", max: "high" };
  return next;
}

/** Discovery owns the capability fields it reports, so a refresh rewrites them on models that
 *  already exist. Manual corrections belong in `modelOverrides`, which this never touches. */
export function mergeDiscoveredModels(existing: NonNullable<ProviderConfig["models"]>, discovered: DiscoveredModel[], overrides: ProviderConfig["modelOverrides"] = {}, edits: Record<string, ModelConfigEdits> = {}, policy?: LegacyDiscoveryPolicy) {
  const byId = new Map(discovered.map((model) => [model.id, model]));
  const modelOverrides: Record<string, Override> = Object.assign(Object.create(null), overrides), conflicts: DiscoveryConflict[] = [];
  const previousOverride = (id: string) => Object.hasOwn(overrides, id) ? overrides[id] : undefined;
  let updated = 0;
  const models = existing.map((model) => {
    const found = byId.get(model.id);
    if (!found) return model;
    const patch = modelConfigFromDiscovery(found), next = { ...model };
    const override = { ...modelOverrides[model.id] };
    for (const key of modelCapabilityFields) {
      const owned = model.discoveredFields?.includes(key);
      if (!owned && model[key] !== undefined && patch[key] !== undefined && !equal(model[key], patch[key]) && override[key] === undefined) {
        conflicts.push({ id: model.id, field: key, current: model[key], discovered: patch[key] });
        if (!policy) continue;
        if (policy === "preserve") Object.assign(override, { [key]: model[key] });
      }
      if (owned) delete next[key];
      if (patch[key] !== undefined) Object.assign(next, { [key]: patch[key] });
    }
    const declaredFields = modelCapabilityFields.filter((key) => patch[key] !== undefined && equal(next[key], patch[key]));
    if (declaredFields.length) next.discoveredFields = declaredFields; else delete next.discoveredFields;
    if (!next.name && patch.name) next.name = patch.name;
    const correction = applyModelEdits(override, edits[model.id]);
    if (Object.keys(correction).length) modelOverrides[model.id] = correction; else delete modelOverrides[model.id];
    if (!equal(model, next) || !equal(previousOverride(model.id) ?? {}, correction)) updated += 1;
    return next;
  });
  const known = new Set(existing.map((model) => model.id));
  const added = [...byId.values()].filter((model) => !known.has(model.id)).map((model) => ({ id: model.id, ...modelConfigFromDiscovery(model) }));
  for (const model of [...models, ...added]) if (!byId.has(model.id) || !known.has(model.id)) {
    const correction = applyModelEdits(modelOverrides[model.id], edits[model.id]);
    if (Object.keys(correction).length) modelOverrides[model.id] = correction; else delete modelOverrides[model.id];
  }
  return { models: [...models, ...added], modelOverrides, conflicts: policy ? [] : conflicts, added: added.length, updated };
}
