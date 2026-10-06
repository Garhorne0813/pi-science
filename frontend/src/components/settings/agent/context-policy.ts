import { resolveAgentCompaction } from "@pi-science/contracts";
import type { SettingsConfig } from "../../../lib/settings";

export function configuredContextWindow(config: SettingsConfig): number | null {
  if (!config.model || config.unavailable_model) return null;
  const selected = config.available_models.find((model) => model.id === config.model);
  if (!selected) return null;
  const override = config.model_context_window_override;
  const window = override?.model === config.model ? override.context_window : selected.context_window;
  return window && Number.isSafeInteger(window) && window > 0 ? window : null;
}

export function contextPolicy(config: SettingsConfig, threshold = config.compaction_threshold_percent) {
  const window = configuredContextWindow(config);
  return window ? { window, ...resolveAgentCompaction(window, { compaction_enabled: config.compaction_enabled, compaction_threshold_percent: threshold }) } : null;
}
