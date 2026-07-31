import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, FlaskConical, Languages, Loader2, Puzzle, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { settingsApi } from "../../lib/settings-api";
import type { SettingsConfig } from "../../lib/settings-types";
import { ComputeSettings } from "./ComputeSettings";
import { ExtensionsTab } from "./ExtensionsTab";
import { GeneralTab } from "./GeneralTab";
import { LLMTab } from "./LLMTab";
import { MCPTab } from "./MCPTab";

type Tab = "general" | "llm" | "extensions" | "mcp" | "compute";

const TAB_GROUPS: { id: string; labelKey: string; tabs: { id: Tab; labelKey: string; icon: React.ReactNode }[] }[] = [
  {
    id: "general",
    labelKey: "settings.group.general",
    tabs: [{ id: "general", labelKey: "settings.general", icon: <Languages size={14} /> }],
  },
  {
    id: "model",
    labelKey: "settings.group.model",
    tabs: [{ id: "llm", labelKey: "settings.llm", icon: <Cpu size={14} /> }],
  },
  {
    id: "capabilities",
    labelKey: "settings.group.capabilities",
    tabs: [
      { id: "extensions", labelKey: "settings.extensions", icon: <Puzzle size={14} /> },
      { id: "mcp", labelKey: "settings.mcp", icon: <FlaskConical size={14} /> },
    ],
  },
  {
    id: "system",
    labelKey: "settings.group.system",
    tabs: [{ id: "compute", labelKey: "settings.compute", icon: <Server size={14} /> }],
  },
];

/** Settings page content: vertical navigation on the left, active tab on the
 *  right. `scope` is the workspace cwd snapshot taken when the dialog opened
 *  (`null` = global settings); it must never read the live route context. */
export function SettingsContent({ scope }: { scope: string | null }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<SettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const changeTab = (next: Tab) => {
    setTab(next);
    // jsdom does not implement scrollTo; guard for tests and old browsers.
    scrollRef.current?.scrollTo?.({ top: 0 });
  };

  // Focus the newly activated tab after keyboard navigation; mouse clicks keep
  // the current focus point.
  const focusTab = (id: Tab) => {
    requestAnimationFrame(() => document.getElementById(`settings-tab-${id}`)?.focus());
  };

  const handleNavKeyDown = (event: React.KeyboardEvent) => {
    const order = TAB_GROUPS.flatMap((group) => group.tabs.map((item) => item.id));
    const index = order.indexOf(tab);
    let next: Tab | null = null;
    if (event.key === "ArrowDown") next = order[(index + 1) % order.length];
    else if (event.key === "ArrowUp") next = order[(index - 1 + order.length) % order.length];
    else if (event.key === "Home") next = order[0];
    else if (event.key === "End") next = order[order.length - 1];
    if (next) {
      event.preventDefault();
      changeTab(next);
      focusTab(next);
    }
  };

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await settingsApi.config<SettingsConfig>(scope));
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [scope]);

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
      await settingsApi.saveModel(model, thinking || config?.thinking || "high", scope);
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
      await settingsApi.saveCompaction(enabled, thresholdPercent, scope);
      await loadConfig();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  if (loading)
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        <Loader2 size={18} className="mr-2 animate-spin" />
        {t("common.loading")}
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1">
      {/* Vertical navigation */}
      <nav role="tablist" aria-orientation="vertical" aria-label={t("nav.settings")} onKeyDown={handleNavKeyDown} className="flex w-12 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border px-2 py-3 md:w-52 md:px-3">
        {TAB_GROUPS.map((group) => (
          <div key={group.id}>
            <p className="mb-1 hidden px-2 text-[10px] font-medium uppercase tracking-wide text-muted md:block">{t(group.labelKey)}</p>
            <div className="flex flex-col gap-0.5">
              {group.tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${item.id}`}
                  aria-selected={tab === item.id}
                  aria-controls="settings-tabpanel"
                  aria-label={t(item.labelKey)}
                  onClick={() => changeTab(item.id)}
                  title={t(item.labelKey)}
                  className={cn(
                    "relative flex min-h-10 items-center gap-2 rounded-input px-2 text-left text-xs font-medium transition-colors",
                    tab === item.id ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
                    tab === item.id && "after:absolute after:left-0 after:top-1/2 after:h-4 after:w-0.5 after:-translate-y-1/2 after:rounded-full after:bg-accent",
                  )}
                >
                  <span className="shrink-0" aria-hidden="true">{item.icon}</span>
                  <span className="hidden truncate md:inline">{t(item.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Active tab */}
      <div ref={scrollRef} id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="settings-page min-w-0 flex-1 overflow-y-auto [&_button]:!min-h-9">
        <div className="mx-auto max-w-[720px] px-6 py-6 md:px-8 md:py-8">
          {error && <p role="alert" className="mb-4 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}
          {tab === "general" && <GeneralTab />}
          {tab === "llm" && <LLMTab config={config} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} deleteKey={deleteKey} saveModel={saveModel} saveCompaction={saveCompaction} onConfigReload={loadConfig} />}
          {tab === "extensions" && <ExtensionsTab workspaceCwd={scope} />}
          {tab === "mcp" && <MCPTab workspaceCwd={scope} />}
          {tab === "compute" && <ComputeSettings workspaceCwd={scope} />}
        </div>
      </div>
    </div>
  );
}
