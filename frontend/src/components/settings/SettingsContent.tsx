import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, FlaskConical, Languages, Loader2, Puzzle, Server, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { settingsApi } from "../../lib/settings";
import type { SettingsConfig } from "../../lib/settings";
import { ComputeSettings } from "./ComputeSettings";
import { ExtensionsTab } from "./ExtensionsTab";
import { GeneralTab } from "./GeneralTab";
import { LLMTab } from "./LLMTab";
import { MCPTab } from "./MCPTab";
import { SkillsTab } from "./SkillsTab";
import { Icon, IconButton } from "../ui/Icon";

type Tab = "general" | "llm" | "skills" | "extensions" | "mcp" | "compute";

const TABS: { id: Tab; labelKey: string; titleKey: string; icon: LucideIcon }[] = [
  { id: "general", labelKey: "settings.general", titleKey: "settings.general", icon: Languages },
  { id: "llm", labelKey: "settings.llm", titleKey: "settings.model.pageTitle", icon: Cpu },
  { id: "skills", labelKey: "skills.title", titleKey: "skills.title", icon: Puzzle },
  { id: "extensions", labelKey: "settings.extensions", titleKey: "settings.extensions", icon: Puzzle },
  { id: "mcp", labelKey: "settings.mcp", titleKey: "settings.mcpPage.title", icon: FlaskConical },
  { id: "compute", labelKey: "settings.compute", titleKey: "settings.computePage.title", icon: Server },
];

/** Settings page content: vertical navigation on the left, active tab on the
 *  right. `scope` is the workspace cwd snapshot taken when the dialog opened
 *  (`null` = global settings); it must never read the live route context. */
export function SettingsContent({ scope, onClose }: { scope: string | null; onClose?: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<SettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0];

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
    const order = TABS.map((item) => item.id);
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* Settings navigation */}
      <aside className="flex w-16 shrink-0 flex-col border-r border-faint bg-surface-2/20 px-2 py-panel md:w-44 md:px-3 md:py-4">
        <div className="flex shrink-0 items-center">
          <IconButton
            icon={X}
            label={t("common.close")}
            size="touch"
            onClick={onClose}
          />
        </div>
        <div className="sr-only">{scope ? t("settings.scope.workspace") : t("settings.scope.global")}</div>
        <nav role="tablist" aria-orientation="vertical" aria-label={t("nav.settings")} onKeyDown={handleNavKeyDown} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto pt-4 md:pt-3">
          {TABS.map((item) => (
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
                "relative flex h-nav min-h-0 w-full items-center justify-center gap-1.5 rounded-input px-2 text-left font-medium transition-colors md:justify-start",
                tab === item.id ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              <Icon icon={item.icon} size="md" className="shrink-0" />
              <span className="hidden min-w-0 truncate text-ui-label md:inline">{t(item.labelKey)}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Active tab */}
      <div ref={scrollRef} id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="settings-page min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[1080px] flex-col px-card py-card md:px-5 md:py-5 lg:px-6">
          <header className="flex shrink-0 items-end justify-between gap-card border-b border-faint pb-panel md:pb-4">
            <h1 id="settings-panel-title" className="text-ui-title font-medium tracking-tight text-text">
              {t(activeTab.titleKey)}
            </h1>
          </header>
          <div className="min-h-0 flex-1">
            {loading ? (
              <div className="flex min-h-[240px] items-center justify-center text-sm text-muted">
                <Icon icon={Loader2} size={18} className="mr-2 animate-spin" />
                {t("common.loading")}
              </div>
            ) : (
              <>
                {error && <p role="alert" className="mb-card rounded-input bg-error/10 px-panel py-2 text-ui-caption text-error">{error}</p>}
                {tab === "general" && <GeneralTab />}
                {tab === "llm" && <LLMTab config={config} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} deleteKey={deleteKey} saveModel={saveModel} saveCompaction={saveCompaction} onConfigReload={loadConfig} />}
                {tab === "skills" && <SkillsTab />}
                {tab === "extensions" && <ExtensionsTab workspaceCwd={scope} />}
                {tab === "mcp" && <MCPTab workspaceCwd={scope} />}
                {tab === "compute" && <ComputeSettings workspaceCwd={scope} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
