import { configPath, readJson, writeJsonAtomic } from "./persistence.js";
import type { RuntimeSkillPolicy } from "../runtime/pi/pi-process.js";

export type SettingsData = {
  api_keys?: Record<string, string>;
  model?: string;
  thinking?: string;
  compaction_enabled?: boolean;
  compaction_threshold_percent?: number;
  model_context_window?: number;
  custom_providers?: Array<{ id: string; name: string; base_url: string; api_key?: string; api: string; models: string[]; reasoning?: boolean; context_window?: number; model_hints?: Record<string, { context_window?: number; reasoning?: boolean; thinking_levels?: string[] }> }>;
  allow_private_providers?: boolean;
  web_access?: Record<string, unknown>;
  mcp_servers?: string[];
  skills_configured?: boolean;
  skill_paths?: string[];
  skill_policies?: Record<string, RuntimeSkillPolicy>;
  model_endpoints?: unknown[];
  [key: string]: unknown;
};

export class SettingsStore {
  private writes: Promise<void> = Promise.resolve();
  private cached: { expiresAt: number; value: SettingsData } | undefined;
  private readonly cacheTtlMs = 2_000;

  async read(): Promise<SettingsData> {
    await this.writes.catch(() => undefined);
    if (this.cached && this.cached.expiresAt > Date.now()) return structuredClone(this.cached.value);
    const value = await readJson<SettingsData>(configPath("config.json"), {});
    this.cached = { expiresAt: Date.now() + this.cacheTtlMs, value: structuredClone(value) };
    return value;
  }

  async update<T>(operation: (config: SettingsData) => T | Promise<T>): Promise<T> {
    const pending = this.writes.catch(() => undefined).then(async () => {
      const config = await readJson<SettingsData>(configPath("config.json"), {});
      const result = await operation(config);
      await writeJsonAtomic(configPath("config.json"), config);
      this.cached = { expiresAt: Date.now() + this.cacheTtlMs, value: structuredClone(config) };
      return result;
    });
    this.writes = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
