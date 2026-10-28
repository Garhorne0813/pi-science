import { isDeepStrictEqual } from "node:util";
import type { Model, ModelCapabilities, ModelRead } from "@pi-science/contracts";
import { resolveCapabilities } from "../capability-resolver.js";
import { canonicalModelRef } from "../runtime-model-resolver.js";
import { resourceError, now } from "./validation.js";
import { manualCapabilityPatch } from "./capabilities.js";
import type { ModelResourceContext } from "./context.js";

type Context = Pick<ModelResourceContext, "ensureMigrated" | "listModels" | "repository" | "settings">;

export async function updateModel(context: Context, providerId: string, modelId: string, body: Record<string, unknown>): Promise<ModelRead> {
  await context.ensureMigrated();
  await context.repository.update((state) => {
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) throw resourceError("resource_not_found", `Provider '${providerId}' was not found`);
    if (provider.kind === "system") throw resourceError("invalid_resource", "System provider models are read-only");
    let current = state.models.find((item) => item.provider_id === providerId && item.model_id === modelId);
    const manual = manualCapabilityPatch(body);
    if (!current) {
      const merged = resolveCapabilities(modelId, [manual]);
      current = {
        provider_id: providerId,
        model_id: modelId,
        display_name: typeof body.display_name === "string" && body.display_name.trim() ? body.display_name.trim() : `${provider.name} · ${modelId}`,
        enabled: body.enabled !== false,
        capabilities: merged.capabilities,
        capability_source: merged.capability_source,
        verified_at: merged.verified_at,
        discovered_at: null,
      };
      state.models.push(current);
    } else {
      const merged = resolveCapabilities(modelId, [
        { ...current.capabilities, source: current.capability_source, verified_at: current.verified_at },
        manual,
      ]);
      current.display_name = typeof body.display_name === "string" && body.display_name.trim() ? body.display_name.trim() : current.display_name;
      current.enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
      current.capabilities = merged.capabilities;
      current.capability_source = merged.capability_source;
      current.verified_at = merged.verified_at;
      current.discovered_at = current.discovered_at ?? null;
    }
  });
  const result = await context.listModels({ provider_id: providerId });
  const model = result.find((item) => item.model_id === modelId);
  if (!model) throw resourceError("resource_not_found", `Model '${providerId}/${modelId}' was not found`);
  return model;
}

export async function applyRuntimeCapabilities(context: Context, providerId: string, modelId: string, patch: Partial<ModelCapabilities>): Promise<Model | null> {
  await context.ensureMigrated();
  const resolve = (model: Model, verifiedAt = model.verified_at) => resolveCapabilities(modelId, [
    { ...model.capabilities, source: model.capability_source, verified_at: model.verified_at },
    { ...patch, source: "runtime", verified_at: verifiedAt },
  ]);
  const unchanged = (model: Model) => model.capability_source === "runtime" && isDeepStrictEqual(model.capabilities, resolve(model).capabilities);
  const snapshot = await context.repository.read();
  const existing = snapshot.models.find((item) => item.provider_id === providerId && item.model_id === modelId);
  // Repeated observations of identical facts do not refresh timestamps or
  // acquire the write lock. The locked path rechecks for concurrent repairs.
  if (!existing) return null;
  if (unchanged(existing)) return structuredClone(existing);
  return context.repository.update((state) => {
    const model = state.models.find((item) => item.provider_id === providerId && item.model_id === modelId);
    if (!model) return null;
    if (unchanged(model)) return structuredClone(model);
    const resolved = resolve(model, now());
    model.capabilities = resolved.capabilities;
    model.capability_source = "runtime";
    model.verified_at = resolved.verified_at;
    return structuredClone(model);
  }, { skipUnchanged: true });
}

export async function deleteModel(context: Context, providerId: string, modelId: string): Promise<{ provider_id: string; model_id: string; default_cleared: boolean }> {
  await context.ensureMigrated();
  const ref = canonicalModelRef(providerId, modelId);
  const state = await context.repository.read();
  if (!state.models.some((model) => model.provider_id === providerId && model.model_id === modelId)) throw resourceError("resource_not_found", `Model '${ref}' was not found`);
  const settings = await context.settings.read();
  const defaultCleared = settings.model === ref || state.aliases[settings.model ?? ""] === ref;
  await context.repository.update((current) => {
    current.models = current.models.filter((model) => model.provider_id !== providerId || model.model_id !== modelId);
    for (const [alias, target] of Object.entries(current.aliases)) if (target === ref) delete current.aliases[alias];
  });
  if (defaultCleared) await context.settings.update((current) => { current.model = ""; });
  return { provider_id: providerId, model_id: modelId, default_cleared: defaultCleared };
}
