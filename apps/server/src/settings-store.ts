import { configPath, readJson, writeJsonAtomic } from "./persistence.js";

export type SettingsData = {
  api_keys?: Record<string, string>;
  model?: string;
  thinking?: string;
  custom_providers?: Array<{ id: string; name: string; base_url: string; api_key?: string; api: string; models: string[] }>;
  web_access?: Record<string, unknown>;
  mcp_servers?: string[];
  skills_configured?: boolean;
  skill_paths?: string[];
  model_endpoints?: unknown[];
  [key: string]: unknown;
};

export class SettingsStore {
  private writes: Promise<void> = Promise.resolve();

  async read(): Promise<SettingsData> {
    await this.writes.catch(() => undefined);
    return readJson<SettingsData>(configPath("config.json"), {});
  }

  async update<T>(operation: (config: SettingsData) => T | Promise<T>): Promise<T> {
    const pending = this.writes.catch(() => undefined).then(async () => {
      const config = await readJson<SettingsData>(configPath("config.json"), {});
      const result = await operation(config);
      await writeJsonAtomic(configPath("config.json"), config);
      return result;
    });
    this.writes = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
