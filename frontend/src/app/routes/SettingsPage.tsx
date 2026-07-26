import { useEffect, useState, useCallback } from "react";
import { Loader2, Cpu, Puzzle, FlaskConical, Languages, Server } from "lucide-react";
import { cn } from "../../lib/cn";
import { settingsApi } from "../../lib/settings-api";
import { useTranslation } from "react-i18next";
import { ComputeSettings } from "../../components/settings/ComputeSettings";
import { ExtensionsTab } from "../../components/settings/ExtensionsTab";
import { GeneralTab } from "../../components/settings/GeneralTab";
import { LLMTab } from "../../components/settings/LLMTab";
import { MCPTab } from "../../components/settings/MCPTab";
import type { SettingsConfig } from "../../lib/settings-types";
import { useWorkspaceCwd } from "../../lib/workspace-context";

type Tab = "general" | "llm" | "extensions" | "mcp" | "compute";

const TABS: { id: Tab; labelKey: string; icon: React.ReactNode }[] = [
  {
    id: "general",
    labelKey: "settings.general",
    icon: <Languages size={14} />,
  },
  { id: "llm", labelKey: "settings.llm", icon: <Cpu size={14} /> },
  {
    id: "extensions",
    labelKey: "settings.extensions",
    icon: <Puzzle size={14} />,
  },
  { id: "mcp", labelKey: "settings.mcp", icon: <FlaskConical size={14} /> },
  { id: "compute", labelKey: "settings.compute", icon: <Server size={14} /> },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const workspaceCwd = useWorkspaceCwd();
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<SettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await settingsApi.config<SettingsConfig>(workspaceCwd));
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [workspaceCwd]);

  useEffect(() => {
    void loadConfig().catch(() => undefined);
  }, [loadConfig]);

  const saveKey = async (provider: string) => {
    const key = apiKeyInput[provider]?.trim();
    if (!key) return;
    setSaving(provider);
    setError(null);
    try {
      await settingsApi.saveApiKey(provider, key);
      setApiKeyInput((prev) => ({ ...prev, [provider]: "" }));
      await loadConfig();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const deleteKey = async (provider: string) => {
    setSaving(provider);
    setError(null);
    try {
      await settingsApi.deleteApiKey(provider);
      await loadConfig();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const saveModel = async (model: string, thinking?: string) => {
    setSaving("model");
    setError(null);
    try {
      await settingsApi.saveModel(model, thinking || config?.thinking || "high", workspaceCwd);
      await loadConfig();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const saveCompaction = async (enabled: boolean, thresholdPercent: number) => {
    setSaving("compaction");
    setError(null);
    try {
      await settingsApi.saveCompaction(enabled, thresholdPercent, workspaceCwd);
      await loadConfig();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  if (loading)
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted">
        <Loader2 size={18} className="animate-spin mr-2" />
        {t("common.loading")}
      </div>
    );

  return (
    <div className="settings-page h-full overflow-y-auto [&_button]:!min-h-9">
      <div className="mx-auto max-w-[720px] px-8 py-8">
        <h1 className="font-serif text-xl text-text mb-6">{t("nav.settings")}</h1>
        {error && <p role="alert" className="mb-4 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}

        {/* Tab bar */}
        <div className="mb-7 flex flex-wrap border-b border-border" role="tablist" aria-label={t("nav.settings")}>
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)} className={cn("-mb-px flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs font-medium transition-colors", tab === item.id ? "border-accent text-text" : "border-transparent text-muted hover:border-border hover:text-text")}>
              {item.icon} {t(item.labelKey)}
            </button>
          ))}
        </div>

        {tab === "general" && <GeneralTab />}
        {tab === "llm" && <LLMTab config={config} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} deleteKey={deleteKey} saveModel={saveModel} saveCompaction={saveCompaction} onConfigReload={loadConfig} />}
        {tab === "extensions" && <ExtensionsTab workspaceCwd={workspaceCwd} />}
        {tab === "mcp" && <MCPTab workspaceCwd={workspaceCwd} />}
        {tab === "compute" && <ComputeSettings />}
      </div>
    </div>
  );
}
