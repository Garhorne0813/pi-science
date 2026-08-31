import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Blocks, Boxes, BrainCircuit, Loader2, ServerCog, Settings2, Unplug, UserRound, WandSparkles, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { settingsApi } from "../../lib/settings";
import type { SettingsConfig } from "../../lib/settings";
import { ComputeSettings } from "./ComputeSettings";
import { ExtensionsTab } from "./ExtensionsTab";
import { GeneralTab } from "./GeneralTab";
import { AIModelsTab } from "./models/AIModelsTab";
import { AgentTab } from "./agent/AgentTab";
import { MCPTab } from "./MCPTab";
import { SkillsTab } from "./SkillsTab";
import { Icon, IconButton } from "../ui/Icon";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { ProgressTab } from "./ProgressTab";

type Tab = "general" | "models" | "agent" | "progress" | "skills" | "extensions" | "mcp" | "compute" | "environments";

const TABS: { id: Tab; labelKey: string; titleKey: string; icon: LucideIcon }[] = [
  { id: "general", labelKey: "settings.general", titleKey: "settings.general", icon: Settings2 },
  { id: "models", labelKey: "settings.models.title", titleKey: "settings.models.title", icon: BrainCircuit },
  { id: "agent", labelKey: "settings.agent.title", titleKey: "settings.agent.title", icon: UserRound },
  { id: "progress", labelKey: "settings.progress.nav", titleKey: "settings.progress.nav", icon: Activity },
  { id: "skills", labelKey: "skills.title", titleKey: "skills.title", icon: WandSparkles },
  { id: "environments", labelKey: "settings.environments", titleKey: "settings.environments", icon: Boxes },
  { id: "extensions", labelKey: "settings.extensions", titleKey: "settings.extensions", icon: Blocks },
  { id: "mcp", labelKey: "settings.mcp", titleKey: "settings.mcpPage.title", icon: Unplug },
  { id: "compute", labelKey: "settings.compute", titleKey: "settings.computePage.title", icon: ServerCog },
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

  const saveProgress = async (progress: import("@pi-science/contracts").ProgressAppearance) => {
    setSaving("progress");
    setError(null);
    try {
      await settingsApi.saveProgress(progress);
      await loadConfig();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* Settings navigation: a light rail on mobile (56px icon column) and a
          quiet 188px column with a title on desktop, mirroring the DeepSeek
          harness SettingsRoot geometry (22px/12px padding, 4px list gap). */}
      <aside className="flex w-14 shrink-0 flex-col border-r border-faint bg-sidebar px-2.5 pt-panel pb-panel md:w-[188px] md:px-3 md:pt-[22px] md:pb-0">
        <div className="sr-only">{scope ? t("settings.scope.workspace") : t("settings.scope.global")}</div>
        <h2 className="hidden px-3 pb-2 text-base font-medium text-text md:block">{t("nav.settings")}</h2>
        <nav role="tablist" aria-orientation="vertical" aria-label={t("nav.settings")} onKeyDown={handleNavKeyDown} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
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
                "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-normal outline-none transition-colors md:h-10 md:w-full md:justify-start md:gap-2 md:rounded-card md:px-3 md:leading-[22px]",
                tab === item.id ? "bg-surface-selected text-text" : "text-muted hover:bg-surface-hover hover:text-text",
              )}
            >
              <Icon icon={item.icon} size={18} className="h-[18px] w-[18px] shrink-0 md:h-4 md:w-4" />
              <span className="hidden min-w-0 truncate md:inline">{t(item.labelKey)}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Active tab. The header stays pinned at the top of the scroll area so
          the close control is always reachable on mobile; it lives in the
          content header (not the sidebar) like the DeepSeek settings panel. */}
      <div ref={scrollRef} id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="settings-page min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[820px] flex-col md:px-6">
          <header className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-card border-b border-faint bg-surface-raised px-card py-panel md:px-0 md:py-4">
            <h1 id="settings-panel-title" className="text-ui-title font-medium tracking-tight text-text">
              {t(activeTab.titleKey)}
            </h1>
            <IconButton
              icon={X}
              label={t("common.close")}
              size="standard"
              className="h-7 w-7 rounded-full hover:bg-surface-hover"
              onClick={onClose}
            />
          </header>
          <div className="min-h-0 flex-1 px-card py-card md:px-0 md:py-6">
            {loading ? (
              <div className="flex min-h-[240px] items-center justify-center text-sm text-muted">
                <Icon icon={Loader2} size={18} className="mr-2 animate-spin" />
                {t("common.loading")}
              </div>
            ) : (
              <>
                {error && <p role="alert" className="mb-card rounded-input bg-error/10 px-panel py-2 text-ui-caption text-error-text">{error}</p>}
                {tab === "general" && <GeneralTab />}
                {tab === "models" && <AIModelsTab config={config} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} deleteKey={deleteKey} onConfigReload={loadConfig} />}
                {tab === "agent" && <AgentTab config={config} saving={saving === "compaction"} onSave={saveCompaction} />}
                {tab === "progress" && config && <ProgressTab config={config} saving={saving === "progress"} onSave={saveProgress} />}
                {tab === "skills" && <SkillsTab workspaceCwd={scope} />}
                {tab === "extensions" && <ExtensionsTab workspaceCwd={scope} />}
                {tab === "mcp" && <MCPTab workspaceCwd={scope} />}
                {tab === "compute" && <ComputeSettings workspaceCwd={scope} />}
                {tab === "environments" && <EnvironmentSettings workspaceCwd={scope} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
