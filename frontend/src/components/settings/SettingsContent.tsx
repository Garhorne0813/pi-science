import type { SettingsSection } from "../../lib/settings/settings-sections";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Activity, Blocks, BookOpen, Boxes, BrainCircuit, ChevronLeft, ChevronRight, ServerCog, Settings2, ShieldCheck, FolderOpen, Globe2, Laptop, Unplug, UserRound, WandSparkles, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { settingsApi } from "../../lib/settings";
import type { SettingsConfig } from "../../lib/settings";
import { GeneralTab } from "./GeneralTab";
import { Icon, IconButton } from "../ui/Icon";

const ComputeSettings = lazy(() => import("./ComputeSettings").then((module) => ({ default: module.ComputeSettings })));
const CapabilitiesTab = lazy(() => import("./CapabilitiesTab").then((module) => ({ default: module.CapabilitiesTab })));
const AIModelsTab = lazy(() => import("./models/AIModelsTab").then((module) => ({ default: module.AIModelsTab })));
const AgentTab = lazy(() => import("./agent/AgentTab").then((module) => ({ default: module.AgentTab })));
const MCPTab = lazy(() => import("./MCPTab").then((module) => ({ default: module.MCPTab })));
const SkillsTab = lazy(() => import("./SkillsTab").then((module) => ({ default: module.SkillsTab })));
const EnvironmentSettings = lazy(() => import("./EnvironmentSettings").then((module) => ({ default: module.EnvironmentSettings })));
const NetworkTab = lazy(() => import("./NetworkTab").then((module) => ({ default: module.NetworkTab })));
const MemoryTab = lazy(() => import("./MemoryTab").then(module=>({default:module.MemoryTab})));
const ProgressTab = lazy(() => import("./ProgressTab").then((module) => ({ default: module.ProgressTab })));

const WebSearchTab = lazy(() => import("./WebSearchTab").then((module) => ({ default: module.WebSearchTab })));

type Tab = SettingsSection;

const GROUP_STARTS: Partial<Record<Tab, string>> = { general: "settings.redesign.workbench", skills: "settings.redesign.capabilities", environments: "settings.redesign.computeGroup" };

type SettingsScope = "device" | "global" | "workspace" | "mixed";

const TABS: { id: Tab; labelKey: string; titleKey: string; icon: LucideIcon; scope: SettingsScope }[] = [
  { id: "general", labelKey: "settings.general", titleKey: "settings.general", icon: Settings2, scope: "device" },
  { id: "models", labelKey: "settings.models.title", titleKey: "settings.models.title", icon: BrainCircuit, scope: "global" },
  { id: "agent", labelKey: "settings.agent.title", titleKey: "settings.agent.title", icon: UserRound, scope: "global" },
  { id: "memory", labelKey: "memory.title", titleKey: "memory.title", icon: BookOpen, scope: "global" },
  { id: "progress", labelKey: "settings.progress.nav", titleKey: "settings.progress.nav", icon: Activity, scope: "device" },
  { id: "skills", labelKey: "skills.title", titleKey: "skills.title", icon: WandSparkles, scope: "mixed" },
  { id: "capabilities", labelKey: "settings.capabilities.title", titleKey: "settings.capabilities.title", icon: Blocks, scope: "mixed" },
  { id: "web-search", labelKey: "settings.webSearch.title", titleKey: "settings.webSearch.title", icon: Globe2, scope: "global" },
  { id: "network", labelKey: "settings.network.title", titleKey: "settings.network.title", icon: ShieldCheck, scope: "global" },
  { id: "mcp", labelKey: "settings.mcp", titleKey: "settings.mcpPage.title", icon: Unplug, scope: "mixed" },
  { id: "environments", labelKey: "settings.environments", titleKey: "settings.environments", icon: Boxes, scope: "mixed" },
  { id: "compute", labelKey: "settings.compute", titleKey: "settings.computePage.title", icon: ServerCog, scope: "workspace" },
];

/** Settings page content: vertical navigation on the left, active tab on the
 *  right. `scope` is the workspace cwd snapshot taken when the dialog opened
 *  (`null` = global settings); it must never read the live route context. */
export function SettingsContent({ scope, onClose, initialTab="general" }: { scope: string | null; onClose?: () => void; initialTab?: SettingsSection }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(initialTab === "general");
  const [config, setConfig] = useState<SettingsConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const needsModelConfig = tab === "agent";
  const requestId = useRef(0);
  useEffect(() => () => { requestId.current++; }, [scope]);
  const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0];
  const effectiveScope = (activeTab.scope === "workspace" || activeTab.scope === "mixed") && !scope ? "global" : activeTab.scope;
  const scopeIcon = effectiveScope === "device" ? Laptop : effectiveScope === "workspace" || effectiveScope === "mixed" ? FolderOpen : Globe2;
  const scopeLabel = effectiveScope === "device" ? t("settings.scope.device") : effectiveScope === "workspace" ? t("settings.scope.currentProject") : effectiveScope === "mixed" ? t("settings.scope.sharedAndProject") : t("settings.scope.allProjects");

  const changeTab = (next: Tab) => {
    setTab(next);
    setMobileMenuOpen(false);
    if (/\/settings\/?$/.test(window.location.pathname)) {
      const url = new URL(window.location.href);
      url.searchParams.set("section", next);
      window.history.replaceState(window.history.state, "", url);
    }
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
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await settingsApi.config<SettingsConfig>(scope);
      if (id === requestId.current) setConfig(next);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (id === requestId.current) setError(message);
      throw e;
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    if (needsModelConfig) void loadConfig().catch(() => undefined);
  }, [needsModelConfig, loadConfig]);

  const saveKey = async (provider: string) => {
    const key = apiKeyInput[provider]?.trim();
    if (!key) return;
    setSaving(provider);
    try {
      await settingsApi.saveApiKey(provider, key);
      setApiKeyInput((prev) => ({ ...prev, [provider]: "" }));
    } finally {
      setSaving(null);
    }
  };

  const deleteKey = async (provider: string) => {
    setSaving(provider);
    try {
      await settingsApi.deleteApiKey(provider);
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
      throw e;
    } finally {
      setSaving(null);
    }
  };


  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className={cn("min-w-0 flex-1 flex-col bg-sidebar px-3 pt-panel pb-panel md:flex md:w-[188px] md:flex-none md:border-r md:border-faint md:pt-[22px] md:pb-0", mobileMenuOpen ? "flex" : "hidden")}>
        <div className="flex items-center justify-between px-3 pb-3 md:block md:pb-2">
          <h2 className="text-base font-medium text-text">{t("nav.settings")}</h2>
          <IconButton icon={X} label={t("common.close")} size="standard" className="h-8 w-8 md:hidden" data-settings-mobile-only="true" onClick={onClose} />
        </div>
        <nav role="tablist" aria-orientation="vertical" aria-label={t("nav.settings")} onKeyDown={handleNavKeyDown} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {TABS.map((item) => (
            <div key={item.id} className="shrink-0">
            {GROUP_STARTS[item.id] && <p role="presentation" className={cn("px-3 pb-2 text-ui-meta font-medium uppercase tracking-wide text-muted", item.id !== "general" && "mt-4")}>{t(GROUP_STARTS[item.id]!)}</p>}
            <button
              type="button"
              role="tab"
              id={`settings-tab-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              aria-selected={tab === item.id}
              aria-controls="settings-tabpanel"
              aria-label={t(item.labelKey)}
              onClick={() => changeTab(item.id)}
              title={t(item.labelKey)}
              className={cn(
                "relative flex h-11 w-full shrink-0 items-center gap-3 rounded-card px-3 text-sm font-normal outline-none transition-colors md:h-10 md:gap-2 md:leading-[22px]",
                tab === item.id ? "bg-surface-selected text-text" : "text-muted hover:bg-surface-hover hover:text-text",
              )}
            >
              <Icon icon={item.icon} size={18} className="h-[18px] w-[18px] shrink-0 md:h-4 md:w-4" />
              <span className="min-w-0 flex-1 truncate text-left">{t(item.labelKey)}</span>
              <ChevronRight size={16} className="text-muted md:hidden" />
            </button>
            </div>
          ))}
        </nav>
      </aside>

      {/* Active tab. The header stays pinned at the top of the scroll area so
          the close control is always reachable on mobile; it lives in the
          content header (not the sidebar) like the DeepSeek settings panel. */}
      <div ref={scrollRef} id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className={cn("settings-page min-w-0 flex-1 overflow-y-auto", mobileMenuOpen && "hidden md:block")}>
        <div className="mx-auto flex min-h-full w-full max-w-[820px] flex-col md:px-6">
          <header className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-card border-b border-faint bg-surface-raised px-card py-panel md:px-0 md:py-4">
            <div className="flex min-w-0 items-center gap-2">
              <IconButton icon={ChevronLeft} label={t("settings.backToSettings")} size="standard" className="h-8 w-8 md:hidden" data-settings-mobile-only="true" onClick={() => setMobileMenuOpen(true)} />
              <div className="min-w-0">
                <h1 id="settings-panel-title" className="truncate text-ui-title font-medium tracking-tight text-text">{t(activeTab.titleKey)}</h1>
                <p className="mt-1 flex items-center gap-1.5 text-ui-meta text-muted"><Icon icon={scopeIcon} size={13} />{scopeLabel}</p>
              </div>
            </div>
            <IconButton
              icon={X}
              label={t("common.close")}
              size="standard"
              className="h-7 w-7 rounded-full hover:bg-surface-hover"
              onClick={onClose}
            />
          </header>
          <div className="min-h-0 flex-1 px-card py-card md:px-0 md:py-6">
            <Suspense fallback={<div role="status" className="py-4 text-sm text-muted">{t("common.loading")}</div>}>
                {tab === "web-search" && <WebSearchTab />}
                {tab === "network" && <NetworkTab />}
                {tab === "general" && <GeneralTab />}
                {tab === "models" && <AIModelsTab scope={scope} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} deleteKey={deleteKey} />}
                {tab === "agent" && <AgentTab config={config} saving={saving === "compaction"} onSave={saveCompaction} scope={scope} loading={loading} error={error} onRefreshContext={loadConfig} onOpenModels={() => { changeTab("models"); focusTab("models"); }} />}
                {tab === "memory" && <MemoryTab />}
                {tab === "progress" && <ProgressTab />}
                {tab === "skills" && <SkillsTab workspaceCwd={scope} />}
                {tab === "capabilities" && <CapabilitiesTab workspaceCwd={scope} onOpenWeb={() => { changeTab("web-search"); focusTab("web-search"); }} onOpenMcp={() => { changeTab("mcp"); focusTab("mcp"); }} />}
                {tab === "mcp" && <MCPTab workspaceCwd={scope} />}
                {tab === "compute" && <ComputeSettings workspaceCwd={scope} />}
                {tab === "environments" && <EnvironmentSettings workspaceCwd={scope} />}
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
