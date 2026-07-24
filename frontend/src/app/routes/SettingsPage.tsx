import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Key, Trash2, Eye, EyeOff, Check, Loader2, Cpu, Puzzle, FlaskConical, Languages, Server, Globe2, Bot, Plus, Save, X, ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";
import { shippedLocales } from "../../i18n/config";
import { useUiStore } from "../../lib/store";
import { applySessionReplacements, type SessionReplacement } from "../../lib/runtime-store";
import { clampThinkingLevel } from "../../lib/pi-science-client";
import { useTranslation } from "react-i18next";

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

const EXTENSION_DESCRIPTION_KEYS: Record<string, string> = {
  "pi-mcp-adapter": "settings.extensionsPage.description.mcp",
  "pi-subagents": "settings.extensionsPage.description.subagents",
  "pi-web-access": "settings.extensionsPage.description.webAccess",
  "context-mode": "settings.extensionsPage.description.contextMode",
};

interface Provider {
  id: string;
  name: string;
  models: string[];
  has_key: boolean;
}

interface CustomProvider {
  id: string;
  name: string;
  base_url: string;
  api: string;
  models: string[];
  has_key: boolean;
}

interface AvailableModel {
  id: string;
  provider: string;
  model: string;
  label: string;
  custom: boolean;
  reasoning: boolean;
  thinking_levels: string[];
  capability_source: string;
}

interface Config {
  api_keys: Record<string, boolean>;
  model: string;
  thinking: string;
  providers: Provider[];
  custom_providers: CustomProvider[];
  available_models: AvailableModel[];
  model_catalog_source?: "pi" | "fallback";
}

export async function readSettingsResponse<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & {
    error?: string;
    detail?: string;
    session_replacements?: SessionReplacement[];
  };
  if (!response.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error(data.error || data.detail || fallback);
  }
  if (Array.isArray(data.session_replacements)) {
    applySessionReplacements(data.session_replacements);
  }
  return data;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { cwd: rawCwd } = useParams<{ cwd: string }>();
  const workspaceCwd = rawCwd ? decodeURIComponent(rawCwd) : null;
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const query = workspaceCwd ? `?cwd=${encodeURIComponent(workspaceCwd)}` : "";
      const res = await fetch(`/api/settings/config${query}`);
      setConfig(await readSettingsResponse<Config>(res, "Unable to load settings"));
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
      const response = await fetch("/api/settings/api-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: key }),
      });
      await readSettingsResponse(response, "Unable to save API key");
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
      const response = await fetch(`/api/settings/api-key/${provider}`, { method: "DELETE" });
      await readSettingsResponse(response, "Unable to delete API key");
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
      const query = workspaceCwd ? `?cwd=${encodeURIComponent(workspaceCwd)}` : "";
      const response = await fetch(`/api/settings/model${query}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          thinking: thinking || config?.thinking || "high",
        }),
      });
      await readSettingsResponse(response, "Unable to save default model");
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
        {tab === "llm" && <LLMTab config={config!} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} deleteKey={deleteKey} saveModel={saveModel} onConfigReload={loadConfig} />}
        {tab === "extensions" && <ExtensionsTab workspaceCwd={workspaceCwd} />}
        {tab === "mcp" && <MCPTab workspaceCwd={workspaceCwd} />}
        {tab === "compute" && <ComputeTab />}
      </div>
    </div>
  );
}

function GeneralTab() {
  const { t } = useTranslation();
  const locale = useUiStore((state) => state.locale);
  const setLocale = useUiStore((state) => state.setLocale);
  return (
    <div className="space-y-6">
      <Section title={t("settings.language.title")}>
        <p className="mb-3 text-[11px] text-muted">{t("settings.language.description")}</p>
        <select aria-label={t("settings.language.label")} value={locale} onChange={(event) => setLocale(event.target.value)} className="min-h-11 w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent">
          {shippedLocales.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.label}
            </option>
          ))}
        </select>
      </Section>
    </div>
  );
}

/* ── LLM Tab ── */

function LLMTab({ config, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, deleteKey, saveModel, onConfigReload }: any) {
  const { t } = useTranslation();
  const [providerToAdd, setProviderToAdd] = useState("");
  const [showVendorPicker, setShowVendorPicker] = useState(false);
  const [providerView, setProviderView] = useState<"vendors" | "custom">("vendors");
  const [showCustomForm, setShowCustomForm] = useState(false);
  if (!config)
    return (
      <div className="text-sm text-muted py-4">
        <Loader2 size={16} className="animate-spin inline mr-2" />
        {t("common.loading")}
      </div>
    );
  const connected = config.providers.filter((provider: Provider) => provider.has_key);
  const availableVendors = config.providers.filter((provider: Provider) => !provider.has_key);
  const selectedProvider = config.providers.find((provider: Provider) => provider.id === providerToAdd);
  const visibleProviders = selectedProvider && !selectedProvider.has_key ? [...connected, selectedProvider] : connected;
  const selectedModel = (config.available_models || []).find((model: AvailableModel) => model.id === config.model);
  const thinkingLevels = selectedModel?.thinking_levels || [];
  const providerSectionId = "provider-configuration";
  const focusProviderConfiguration = () => {
    setProviderView("vendors");
    requestAnimationFrame(() => document.getElementById(providerSectionId)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  return (
    <div className="space-y-4">
      <Section title={t("settings.model.pageTitle")}>
        <p className="text-[11px] text-muted">{t("settings.model.pageDescription")}</p>
      </Section>
      <section className="overflow-hidden rounded-card border border-border bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-faint px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-text">{t("settings.model.defaultTitle")}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">{t("settings.model.defaultDescription")}</p>
          </div>
          <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium", config.model ? "bg-ok/10 text-ok" : "bg-surface-2 text-muted")}>
            {config.model ? t("settings.model.active") : t("settings.model.notConfigured")}
          </span>
        </div>
        <div className="px-5 py-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1.35fr)_minmax(220px,1fr)] md:items-start">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">{t("settings.model.model")}</span>
              <select aria-label={t("settings.model.defaultLabel")} value={config.model || ""} disabled={(config.available_models || []).length === 0 || saving === "model"} onChange={(event) => { const nextModel = (config.available_models || []).find((model: AvailableModel) => model.id === event.target.value); void saveModel(event.target.value, clampThinkingLevel(config.thinking, nextModel?.thinking_levels || [])); }} className="min-h-11 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none transition-colors focus:border-accent disabled:cursor-not-allowed disabled:opacity-50">
                <option value="">{(config.available_models || []).length === 0 ? t("settings.model.configureFirst") : t("settings.model.select")}</option>
                {(config.available_models || []).map((model: AvailableModel) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted">{t("settings.model.thinking")}</span>
              </div>
              {!selectedModel && <p className="flex min-h-10 items-center rounded-input border border-border bg-surface px-3 text-xs text-muted">{t("settings.model.thinkingHint")}</p>}
              {selectedModel && !selectedModel.reasoning && <p className="flex min-h-10 items-center rounded-input border border-border bg-surface px-3 text-xs text-muted">{t("settings.model.noReasoning")}</p>}
              {selectedModel?.reasoning && (
                <div className="flex min-h-10 w-full flex-wrap items-center gap-1 rounded-input border border-border bg-surface p-0.5" role="group" aria-label={t("settings.model.thinking")}>
                  {thinkingLevels.map((level: string) => (
                    <button key={level} disabled={saving === "model"} onClick={() => saveModel(config.model, level)} className={cn("min-h-9 min-w-[3.5rem] flex-1 rounded-input px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-50", config.thinking === level ? "bg-surface-2 text-text shadow-sm ring-1 ring-border/70" : "text-muted hover:bg-surface-2/70 hover:text-text")}>
                      {level}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-faint pt-3">
            <span className="text-xs text-muted">
              {t("settings.model.availableCount", {
                count: (config.available_models || []).length,
              })}
            </span>
            {selectedModel && <span className="text-[11px] text-muted">{selectedModel.capability_source}</span>}
            {(config.available_models || []).length === 0 && (
              <button type="button" onClick={focusProviderConfiguration} className="min-h-9 rounded-input px-2.5 text-xs font-medium text-accent hover:bg-accent/10">
                {t("settings.provider.configure")}
              </button>
            )}
          </div>
        </div>
      </section>

      <section id={providerSectionId} className="overflow-hidden rounded-card border border-border bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-text">{t("settings.provider.title")}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">{t("settings.provider.description")}</p>
          </div>
          {providerView === "vendors" && (
            <button type="button" disabled={availableVendors.length === 0} onClick={() => setShowVendorPicker((value) => !value)} className="flex min-h-9 items-center gap-1.5 rounded-input border border-border px-3 text-xs font-medium text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50">
              <Plus size={13} /> {t("settings.provider.addVendor")}
            </button>
          )}
        </div>
        <div className="flex border-y border-faint px-3" role="tablist" aria-label={t("settings.provider.views")}>
            {[
              { id: "vendors", label: t("settings.provider.vendors") },
              { id: "custom", label: t("settings.provider.custom") },
            ].map((view) => (
              <button key={view.id} type="button" role="tab" aria-selected={providerView === view.id} aria-controls={`${providerSectionId}-${view.id}`} onClick={() => setProviderView(view.id as "vendors" | "custom")} className={cn("-mb-px min-h-11 border-b-2 px-3 text-xs font-medium", providerView === view.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>
                {view.label}
              </button>
            ))}
        </div>
        <div className="px-5 py-4">
          {providerView === "vendors" ? (
            <div id={`${providerSectionId}-vendors`} role="tabpanel" aria-label={t("settings.provider.vendors")}>
              {showVendorPicker && (
                <div className="mb-4 flex flex-wrap items-center gap-2 rounded-input bg-surface-2 p-3">
                  <select autoFocus aria-label={t("settings.provider.chooseVendor")} value={providerToAdd} onChange={(event) => { setProviderToAdd(event.target.value); if (event.target.value) setShowVendorPicker(false); }} className="min-h-10 min-w-[220px] rounded-input border border-border bg-surface px-3 py-2 text-xs text-text outline-none focus:border-accent">
                    <option value="">{t("settings.provider.chooseVendor")}</option>
                    {availableVendors.map((provider: Provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                  <span className="text-xs text-muted">{t("settings.provider.builtinOnly")}</span>
                </div>
              )}
              {visibleProviders.length === 0 ? (
                <p className="rounded-input border border-dashed border-border px-4 py-6 text-center text-xs text-muted">{t("settings.provider.empty")}</p>
              ) : (
                <div className="divide-y divide-faint rounded-input border border-border">
                  {visibleProviders.map((p: Provider) => (
                  <div key={p.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="text-[13px] font-medium text-text">{p.name}</span>
                        <span className="ml-2 font-mono text-[11px] text-muted">{p.id}</span>
                      </div>
                      {p.has_key && (
                        <span className="flex items-center gap-1 text-[11px] font-medium text-ok">
                          <Check size={10} /> {t("settings.provider.connected")}
                        </span>
                      )}
                    </div>
                    {p.has_key ? (
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-xs text-muted">
                          {t("settings.provider.modelCount", {
                            count: p.models.length,
                          })}
                        </span>
                        <button onClick={() => deleteKey(p.id)} disabled={saving === p.id} className="flex min-h-9 items-center gap-1 rounded-input px-2 text-xs text-error hover:bg-error/10">
                          <Trash2 size={11} /> {t("common.delete")}
                        </button>
                      </div>
                    ) : (
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <div className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-input border border-border bg-surface-2 px-3 py-1.5">
                          <input
                            aria-label={`${p.name} API key`}
                            type={showKey[p.id] ? "text" : "password"}
                            value={apiKeyInput[p.id] || ""}
                            onChange={(e) =>
                              setApiKeyInput((prev: any) => ({
                                ...prev,
                                [p.id]: e.target.value,
                              }))
                            }
                            placeholder={p.id === "anthropic" ? "sk-ant-..." : "sk-..."}
                            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-text outline-none"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveKey(p.id);
                            }}
                          />
                          <button
                            type="button"
                            aria-label={showKey[p.id] ? t("settings.apiKey.hide") : t("settings.apiKey.show")}
                            onClick={() =>
                              setShowKey((prev: any) => ({
                                ...prev,
                                [p.id]: !prev[p.id],
                              }))
                            }
                            className="min-h-9 min-w-9 text-muted hover:text-text"
                          >
                            {showKey[p.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                        <button onClick={() => saveKey(p.id)} disabled={!apiKeyInput[p.id]?.trim() || saving === p.id} className="flex min-h-11 items-center justify-center gap-1 rounded-input bg-accent px-3 text-xs font-medium text-accent-fg disabled:opacity-40">
                          {saving === p.id ? <Loader2 size={12} className="animate-spin" /> : <Key size={12} />} {t("settings.actions.save")}
                        </button>
                      </div>
                    )}
                  </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div id={`${providerSectionId}-custom`} role="tabpanel" aria-label={t("settings.provider.customProviders")}>
              <CustomApiSection providers={config.custom_providers || []} onConfigReload={onConfigReload} isOpen={showCustomForm} onOpen={() => setShowCustomForm(true)} onClose={() => setShowCustomForm(false)} />
            </div>
          )}
        </div>
      </section>
      <ModelEndpointSection />
    </div>
  );
}

function ModelEndpointSection() {
  type Endpoint = {
    endpoint_id: string;
    name: string;
    base_url: string;
    protocol: string;
    enabled: boolean;
    health: string;
    data_egress: string;
    error?: string | null;
  };
  const { t } = useTranslation();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState("openai");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/endpoints");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || t("settings.endpoints.loadError"));
    setEndpoints(data.endpoints || []);
  }, [t]);
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);

  const add = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    setError(null);
    const response = await fetch("/api/endpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        base_url: baseUrl.trim(),
        protocol,
        data_egress: "remote",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(data.error || data.detail || t("settings.endpoints.registerError"));
      return;
    }
    setName("");
    setBaseUrl("");
    await load();
  };

  const health = async (endpointId: string) => {
    await fetch(`/api/endpoints/${encodeURIComponent(endpointId)}/health`, {
      method: "POST",
    });
    await load();
  };

  const toggle = async (endpoint: Endpoint) => {
    await fetch(`/api/endpoints/${encodeURIComponent(endpoint.endpoint_id)}/enabled?enabled=${!endpoint.enabled}`, { method: "PUT" });
    await load();
  };

  return (
    <details className="group overflow-hidden rounded-card border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 marker:content-none">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text">{t("settings.endpoints.title")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t("settings.endpoints.description")}</p>
        </div>
        {endpoints.length > 0 && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{endpoints.length}</span>}
        <ChevronDown size={15} className="shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-faint px-5 py-4">
        {error && <p className="mb-3 rounded-input bg-error/10 px-3 py-2 text-xs text-error">{error}</p>}
        <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("settings.endpoints.name")} className="min-h-10 rounded-input border border-border bg-bg px-3 py-2 text-xs text-text outline-none focus:border-accent" />
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://host/v1" className="min-h-10 rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent" />
          <button type="button" onClick={() => void add()} className="min-h-10 rounded-input bg-accent px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40" disabled={!name.trim() || !baseUrl.trim()}>
            {t("settings.endpoints.register")}
          </button>
        </div>
        <select value={protocol} onChange={(event) => setProtocol(event.target.value)} className="mt-2 min-h-10 rounded-input border border-border bg-bg px-3 py-2 text-xs text-text outline-none focus:border-accent">
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic-compatible</option>
          <option value="native">Native HTTP</option>
        </select>
        <div className="mt-4 divide-y divide-faint rounded-input border border-border empty:hidden">
          {endpoints.map((endpoint) => (
            <div key={endpoint.endpoint_id} className="flex min-h-11 items-center gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-text">
                {endpoint.name}
                <span className="ml-2 font-mono text-[11px] text-muted">{endpoint.base_url}</span>
              </span>
              <span className={cn("text-[11px]", endpoint.health === "ready" ? "text-ok" : endpoint.health === "error" ? "text-error" : "text-muted")}>{endpoint.health}</span>
              <button type="button" onClick={() => void health(endpoint.endpoint_id)} className="rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2">{t("settings.endpoints.check")}</button>
              <button type="button" onClick={() => void toggle(endpoint)} className={cn("rounded-input px-2 py-1 text-xs", endpoint.enabled ? "bg-ok/10 text-ok" : "bg-surface-2 text-muted")}>{endpoint.enabled ? t("settings.actions.on") : t("settings.actions.off")}</button>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function CustomApiSection({ providers, onConfigReload, isOpen, onOpen, onClose }: { providers: CustomProvider[]; onConfigReload: () => Promise<void>; isOpen: boolean; onOpen: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [discovered, setDiscovered] = useState<CustomProvider | null>(null);
  const [busy, setBusy] = useState<"discover" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discover = async () => {
    if (!baseUrl.trim()) return;
    setBusy("discover");
    setError(null);
    try {
      const res = await fetch("/api/settings/custom-providers/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || "Custom API",
          base_url: baseUrl.trim(),
          api_key: apiKey,
          api,
        }),
      });
      const data = await readSettingsResponse<{ provider: CustomProvider }>(res, t("settings.custom.discoveryError"));
      setDiscovered(data.provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!discovered) return;
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`/api/settings/custom-providers/${encodeURIComponent(discovered.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: discovered.name,
          base_url: discovered.base_url,
          api_key: apiKey,
          api: discovered.api,
          models: discovered.models,
        }),
      });
      await readSettingsResponse(res, t("settings.custom.saveError"));
      setDiscovered(null);
      setName("");
      setBaseUrl("");
      setApiKey("");
      await onConfigReload();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/settings/custom-providers/${encodeURIComponent(id)}`, { method: "DELETE" });
      await readSettingsResponse(res, t("settings.custom.removeError"));
      await onConfigReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const closeForm = () => {
    setName("");
    setBaseUrl("");
    setApiKey("");
    setDiscovered(null);
    setError(null);
    onClose();
  };

  return (
    <div>
      {!isOpen && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-text">{t("settings.custom.title")}</p>
            <p className="text-[11px] text-muted">{t("settings.custom.description")}</p>
          </div>
          <button type="button" onClick={onOpen} className="min-h-11 rounded-input bg-accent px-3 text-[12px] font-medium text-accent-fg">
            + {t("settings.custom.add")}
          </button>
        </div>
      )}
      {isOpen && (
        <div className="rounded-card border border-border bg-surface px-4 py-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-text">{t("settings.custom.add")}</p>
            <button type="button" onClick={closeForm} className="min-h-11 rounded-input px-3 text-[12px] text-muted hover:bg-surface-2 hover:text-text">
              {t("common.cancel")}
            </button>
          </div>
          <p className="text-[11px] text-muted">
            {t("settings.custom.formPrefix")} <code className="font-mono">/models</code> {t("settings.custom.formSuffix")}
          </p>
          {error && <p className="rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("settings.custom.name")} className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none" />
            <select value={api} onChange={(e) => setApi(e.target.value)} className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none">
              <option value="openai-completions">OpenAI Chat Completions</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </div>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className="w-full rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
          <div className="flex gap-2">
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t("settings.web.apiKey")} className="min-w-0 flex-1 rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
            <button onClick={discover} disabled={!baseUrl.trim() || busy !== null} className="rounded-input bg-accent px-3 py-2 text-[12px] font-medium text-accent-fg disabled:opacity-40">
              {busy === "discover" ? t("settings.custom.discovering") : t("settings.custom.discover")}
            </button>
          </div>
          {discovered && (
            <div className="rounded-input border border-accent/30 bg-accent/5 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text">{discovered.name}</span>
                <button onClick={save} disabled={busy !== null} className="rounded-input bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg disabled:opacity-40">
                  {busy === "save" ? t("settings.custom.saving") : t("settings.custom.save")}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-muted">
                {t("settings.custom.discoveredCount", {
                  count: discovered.models.length,
                })}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {discovered.models.map((model) => (
                  <span key={model} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text">
                    {model}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {providers.length > 0 && (
        <div className="mt-3 space-y-2">
          {providers.map((provider) => (
            <div key={provider.id} className="flex items-start justify-between gap-3 rounded-card border border-border bg-surface px-3 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium text-text">
                  <span className="truncate">{provider.name}</span>
                  {provider.has_key && <span className="text-[10px] text-ok">{t("settings.web.keySaved")}</span>}
                </div>
                <p className="truncate font-mono text-[10px] text-muted">{provider.base_url}</p>
                <p className="mt-1 text-[10px] text-muted">{provider.models.join(", ")}</p>
              </div>
              <button type="button" onClick={() => remove(provider.id)} className="min-h-9 shrink-0 rounded-input px-2 py-1 text-[11px] text-error hover:bg-error/10">
                {t("common.delete")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Extensions Tab ── */

function ExtensionsTab({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  const [extensions, setExtensions] = useState<Array<{
    id: string;
    name: string;
    description: string;
    installed: boolean;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/extensions")
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.detail || t("settings.extensionsPage.loadError"));
        if (!cancelled) setExtensions(data.extensions || []);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <div className="space-y-6">
      <Section title={t("settings.extensionsPage.title")}>
        <p className="text-[11px] text-muted mb-3">
          {t("settings.extensionsPage.descriptionPrefix")} <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">bash scripts/fetch-pi.sh</code> {t("settings.extensionsPage.descriptionSuffix")}
        </p>
        {error && (
          <p role="alert" className="mb-3 text-xs text-error">
            {error}
          </p>
        )}
        {extensions === null && !error && <p className="text-xs text-muted">{t("settings.extensionsPage.checking")}</p>}
        {extensions?.map((extension) => (
          <ExtCard key={extension.id} name={extension.name} pkg={extension.id} desc={EXTENSION_DESCRIPTION_KEYS[extension.id] ? t(EXTENSION_DESCRIPTION_KEYS[extension.id]) : extension.description} checked={extension.installed} />
        ))}
      </Section>
      <WebAccessSettings />
      <SubagentSettings workspaceCwd={workspaceCwd} />
      <AgentProfilesSection />
    </div>
  );
}

type WebProvider = {
  id: string;
  has_key: boolean;
  key_source: "web-access" | "environment" | "llm-settings" | null;
  env: string;
};
type WebAccessConfig = {
  provider: string;
  workflow: string;
  providers: WebProvider[];
};

function WebAccessSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<WebAccessConfig | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const selectedProvider = config?.providers.find((provider) => provider.id === config.provider) || null;

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/web-access");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || t("settings.web.loadError"));
    setConfig(data);
  }, [t]);

  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);

  const save = async (removeKeys: string[] = [], includeDraftKeys = true) => {
    if (!config) return;
    const keyPayload = includeDraftKeys && selectedProvider && keys[selectedProvider.id]?.trim() ? { [selectedProvider.id]: keys[selectedProvider.id] } : {};
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/settings/web-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: config.provider,
          workflow: config.workflow,
          api_keys: keyPayload,
          remove_keys: removeKeys,
        }),
      });
      const data = await readSettingsResponse<WebAccessConfig>(response, t("settings.web.saveError"));
      setConfig(data);
      setKeys({});
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("settings.web.title")}>
      <div className="mb-3 flex items-start gap-2 rounded-input bg-surface-2 px-3 py-2">
        <Globe2 size={15} className="mt-0.5 shrink-0 text-accent" />
        <p className="text-[11px] text-muted">{t("settings.web.description")}</p>
      </div>
      {error && (
        <p role="alert" className="mb-3 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">
          {error}
        </p>
      )}
      {!config ? (
        <p className="text-xs text-muted">
          <Loader2 size={12} className="mr-1 inline animate-spin" />
          {t("common.loading")}
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-[minmax(170px,0.7fr)_minmax(0,1.3fr)]">
            <label>
              <span className="mb-1 block text-[11px] font-medium text-muted">{t("settings.web.provider")}</span>
              <select
                value={config.provider}
                onChange={(event) => {
                  setConfig({ ...config, provider: event.target.value });
                  setSaved(false);
                }}
                className="min-h-11 w-full rounded-input border border-border bg-surface px-3 text-[12px] text-text outline-none focus:border-accent"
              >
                <option value="auto">{t("settings.web.auto")}</option>
                {config.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-muted">
                <span>{t("settings.web.apiKey")}</span>
                {selectedProvider?.has_key && <span className="font-normal text-ok">{selectedProvider.key_source === "llm-settings" ? t("settings.web.fromLlm") : selectedProvider.key_source === "environment" ? t("settings.web.fromEnvironment") : t("settings.web.keySaved")}</span>}
              </span>
              <div className="flex gap-2">
                <div className="flex min-h-11 min-w-0 flex-1 items-center rounded-input border border-border bg-surface-2 px-3">
                  <input
                    aria-label={t("settings.web.searchApiKey")}
                    type={selectedProvider && visible[selectedProvider.id] ? "text" : "password"}
                    disabled={!selectedProvider}
                    value={selectedProvider ? keys[selectedProvider.id] || "" : ""}
                    onChange={(event) =>
                      selectedProvider &&
                      setKeys((current) => ({
                        ...current,
                        [selectedProvider.id]: event.target.value,
                      }))
                    }
                    placeholder={selectedProvider ? (selectedProvider.has_key ? t("settings.web.replaceKey") : `${selectedProvider.env}`) : t("settings.web.autoKeyHint")}
                    className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  {selectedProvider && (
                    <button
                      type="button"
                      aria-label={visible[selectedProvider.id] ? t("settings.apiKey.hide") : t("settings.apiKey.show")}
                      onClick={() =>
                        setVisible((current) => ({
                          ...current,
                          [selectedProvider.id]: !current[selectedProvider.id],
                        }))
                      }
                      className="min-h-9 min-w-9 text-muted hover:text-text"
                    >
                      {visible[selectedProvider.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  )}
                </div>
                {selectedProvider?.key_source === "web-access" && (
                  <button type="button" aria-label={t("settings.web.removeKey")} onClick={() => void save([selectedProvider.id], false)} disabled={busy} className="min-h-11 rounded-input px-3 text-error hover:bg-error/10">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </label>
          </div>
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-medium text-muted">{t("settings.web.workflow")}</span>
            <select
              value={config.workflow}
              onChange={(event) => {
                setConfig({ ...config, workflow: event.target.value });
                setSaved(false);
              }}
              className="min-h-10 w-full rounded-input border border-border bg-surface px-3 text-[12px] text-text outline-none focus:border-accent"
            >
              <option value="none">{t("settings.web.raw")}</option>
              <option value="auto-summary">{t("settings.web.autoSummary")}</option>
              <option value="summary-review">{t("settings.web.reviewSummary")}</option>
            </select>
          </label>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-faint pt-3">
            <span className="text-[10px] text-muted">{saved ? t("settings.web.savedHint") : t("settings.web.applyHint")}</span>
            <button type="button" onClick={() => void save()} disabled={busy} className="flex min-h-10 items-center gap-1 rounded-input bg-accent px-3 text-[12px] font-medium text-accent-fg disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} {t("settings.actions.save")}
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

type ProjectSubagent = {
  name: string;
  description: string;
  prompt: string;
  model: string;
  thinking: string;
  tools: string;
  system_prompt_mode: "replace" | "append";
  inherit_project_context: boolean;
  inherit_skills: boolean;
  default_context: "fresh" | "fork";
  path?: string;
};

const EMPTY_SUBAGENT: ProjectSubagent = {
  name: "",
  description: "",
  prompt: "",
  model: "",
  thinking: "high",
  tools: "read, grep, find, ls",
  system_prompt_mode: "replace",
  inherit_project_context: true,
  inherit_skills: false,
  default_context: "fresh",
};

function SubagentSettings({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<ProjectSubagent[]>([]);
  const [draft, setDraft] = useState<ProjectSubagent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceCwd) return;
    const response = await fetch(`/api/settings/subagents?cwd=${encodeURIComponent(workspaceCwd)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || t("settings.subagents.loadError"));
    setAgents(data.agents || []);
  }, [workspaceCwd, t]);
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);

  const save = async () => {
    if (!workspaceCwd || !draft) return;
    const name = draft.name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || !draft.prompt.trim()) {
      setError(t("settings.subagents.validation"));
      return;
    }
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/settings/subagents/${encodeURIComponent(name)}?cwd=${encodeURIComponent(workspaceCwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draft, name, prompt: draft.prompt.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(data.error || data.detail || t("settings.subagents.saveError"));
      setBusy(false);
      return;
    }
    setDraft(null);
    setNotice(t("settings.subagents.saved"));
    setBusy(false);
    await load();
  };

  const remove = async (agent: ProjectSubagent) => {
    if (!workspaceCwd || !window.confirm(t("settings.subagents.deleteConfirm", { name: agent.name }))) return;
    setError(null);
    const response = await fetch(`/api/settings/subagents/${encodeURIComponent(agent.name)}?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(data.error || data.detail || t("settings.subagents.deleteError"));
      return;
    }
    setNotice(t("settings.subagents.deleted"));
    await load();
  };

  return (
    <Section title={t("settings.subagents.title")}>
      <div className="mb-3 flex items-start gap-2 rounded-input bg-surface-2 px-3 py-2">
        <Bot size={15} className="mt-0.5 shrink-0 text-accent" />
        <p className="text-[11px] text-muted">
          {t("settings.subagents.description")} <code className="font-mono">.pi/agents/</code>
          {t("settings.subagents.descriptionSuffix")}
        </p>
      </div>
      {!workspaceCwd ? (
        <p className="rounded-input border border-dashed border-border px-3 py-3 text-[11px] text-muted">{t("settings.subagents.workspaceRequired")}</p>
      ) : (
        <>
          {error && (
            <p role="alert" className="mb-3 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">
              {error}
            </p>
          )}
          {notice && <p className="mb-3 rounded-input bg-ok/10 px-3 py-2 text-[11px] text-ok">{notice}</p>}
          <div className="space-y-2">
            {agents.map((agent) => (
              <div key={agent.name} className="flex items-start gap-3 rounded-input border border-border bg-surface px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-medium text-text">{agent.name}</span>
                    {agent.model && <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[9px] text-muted">{agent.model}</span>}
                  </div>
                  <p className="mt-1 text-[11px] text-muted">{agent.description || t("settings.subagents.noDescription")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDraft({ ...agent });
                    setNotice(null);
                  }}
                  className="min-h-9 rounded-input px-2 text-[11px] text-accent hover:bg-accent/10"
                >
                  {t("settings.actions.edit")}
                </button>
                <button type="button" onClick={() => void remove(agent)} className="min-h-9 rounded-input px-2 text-error hover:bg-error/10">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          {!draft && (
            <button
              type="button"
              onClick={() => {
                setDraft({ ...EMPTY_SUBAGENT });
                setNotice(null);
              }}
              className="mt-3 flex min-h-10 items-center gap-1 rounded-input border border-border bg-surface-2 px-3 text-[12px] font-medium text-text hover:bg-surface"
            >
              <Plus size={13} /> {t("settings.subagents.new")}
            </button>
          )}
          {draft && (
            <div className="mt-4 rounded-card border border-border bg-surface p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-medium text-text">{agents.some((agent) => agent.name === draft.name) ? t("settings.subagents.editTitle", { name: draft.name }) : t("settings.subagents.new")}</h3>
                <button type="button" onClick={() => setDraft(null)} className="min-h-9 min-w-9 text-muted hover:text-text">
                  <X size={14} />
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.name")}</span>
                  <input
                    value={draft.name}
                    disabled={agents.some((agent) => agent.name === draft.name)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        name: event.target.value.toLowerCase().replace(/\s+/g, "-"),
                      })
                    }
                    placeholder="literature-auditor"
                    className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 font-mono text-[12px] text-text outline-none disabled:opacity-60"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.descriptionLabel")}</span>
                  <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder={t("settings.subagents.descriptionPlaceholder")} className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 text-[12px] text-text outline-none" />
                </label>
                <label>
                  <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.modelOverride")}</span>
                  <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder={t("settings.subagents.inheritModel")} className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 font-mono text-[12px] text-text outline-none" />
                </label>
                <label>
                  <span className="mb-1 block text-[11px] text-muted">{t("settings.model.thinking")}</span>
                  <select value={draft.thinking} onChange={(event) => setDraft({ ...draft, thinking: event.target.value })} className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 text-[12px] text-text outline-none">
                    <option value="">{t("settings.subagents.inherit")}</option>
                    {["off", "low", "medium", "high", "xhigh", "max"].map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="mt-3 block">
                <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.builtinTools")}</span>
                <input value={draft.tools} onChange={(event) => setDraft({ ...draft, tools: event.target.value })} placeholder="read, grep, find, ls" className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 font-mono text-[12px] text-text outline-none" />
              </label>
              <label className="mt-3 block">
                <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.systemPrompt")}</span>
                <textarea value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} rows={8} placeholder={t("settings.subagents.promptPlaceholder")} className="w-full rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-text outline-none focus:border-accent" />
              </label>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={draft.inherit_project_context}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        inherit_project_context: event.target.checked,
                      })
                    }
                  />{" "}
                  {t("settings.subagents.inheritProject")}
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={draft.inherit_skills}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        inherit_skills: event.target.checked,
                      })
                    }
                  />{" "}
                  {t("settings.subagents.inheritSkills")}
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  {t("settings.subagents.promptMode")}{" "}
                  <select
                    value={draft.system_prompt_mode}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        system_prompt_mode: event.target.value as "replace" | "append",
                      })
                    }
                    className="rounded-input border border-border bg-surface-2 px-2 py-1"
                  >
                    <option value="replace">{t("settings.subagents.replace")}</option>
                    <option value="append">{t("settings.subagents.append")}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  {t("settings.subagents.context")}{" "}
                  <select
                    value={draft.default_context}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        default_context: event.target.value as "fresh" | "fork",
                      })
                    }
                    className="rounded-input border border-border bg-surface-2 px-2 py-1"
                  >
                    <option value="fresh">{t("settings.subagents.fresh")}</option>
                    <option value="fork">{t("settings.subagents.fork")}</option>
                  </select>
                </label>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setDraft(null)} className="min-h-10 rounded-input px-3 text-[12px] text-muted hover:bg-surface-2">
                  {t("common.cancel")}
                </button>
                <button type="button" onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.prompt.trim()} className="flex min-h-10 items-center gap-1 rounded-input bg-accent px-3 text-[12px] font-medium text-accent-fg disabled:opacity-40">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} {t("settings.subagents.save")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function AgentProfilesSection() {
  const { t } = useTranslation();
  type Profile = {
    name: string;
    display_name: string;
    description: string;
    read_scope?: string[];
    write_scope?: string[];
    unrestricted?: boolean;
    source: string;
  };
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/agent-profiles");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || t("settings.profiles.loadError"));
    setProfiles(data.profiles || []);
  }, [t]);
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);
  const create = async () => {
    const normalized = name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_");
    if (!normalized || !displayName.trim()) return;
    const response = await fetch("/api/agent-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: normalized,
        display_name: displayName.trim(),
        description: "User-created profile",
        read_scope: ["workspace"],
        write_scope: ["workspace-approved"],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(data.error || data.detail || t("settings.profiles.createError"));
      return;
    }
    setName("");
    setDisplayName("");
    await load();
  };
  return (
    <Section title={t("settings.profiles.title")}>
      <p className="mb-3 text-[11px] text-muted">{t("settings.profiles.description")}</p>
      {error && <p className="mb-2 text-[11px] text-error">{error}</p>}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="PROFILE_NAME" className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={t("settings.profiles.displayName")} className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none" />
        <button type="button" onClick={() => void create()} className="rounded-input bg-accent px-3 py-2 text-[12px] font-medium text-accent-fg disabled:opacity-40" disabled={!name.trim() || !displayName.trim()}>
          {t("settings.profiles.create")}
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {profiles.map((profile) => (
          <div key={profile.name} className="rounded-input border border-border bg-surface px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-text">{profile.display_name}</span>
              <span className="font-mono text-[10px] text-muted">
                {profile.name} · {profile.source}
              </span>
            </div>
            <p className="mt-1 text-[10px] text-muted">
              {profile.unrestricted
                ? t("settings.profiles.unrestricted")
                : <>{t("settings.profiles.read")}: {(profile.read_scope || []).join(", ") || t("settings.profiles.none")} · {t("settings.profiles.write")}: {(profile.write_scope || []).join(", ") || t("settings.profiles.none")}</>}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ExtCard({ name, pkg, desc, checked }: { name: string; pkg: string; desc: string; checked: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3 mb-2">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <span className="text-sm font-medium text-text">{name}</span>
          <span className="ml-2 font-mono text-[10px] text-muted">{pkg}</span>
          <p className="text-[11px] text-muted mt-0.5">{desc}</p>
        </div>
        {checked ? (
          <span className="rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-medium text-ok ring-1 ring-ok/30">
            <Check size={10} className="inline mr-0.5" />
            {t("settings.extensionsPage.installed")}
          </span>
        ) : (
          <span className="rounded-full bg-error/10 px-2 py-0.5 text-[10px] font-medium text-error ring-1 ring-error/20">{t("settings.extensionsPage.missing")}</span>
        )}
      </div>
    </div>
  );
}

/* ── MCP Tab ── */

function MCPTab({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  interface McpServer {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    health: string;
    auth: string;
    data_egress: string;
    transport: string;
    tools: Array<{ name: string }>;
    terms_url?: string | null;
    privacy_url?: string | null;
    error?: string | null;
  }
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceCwd) {
      setLoading(false);
      setServers([]);
      setError(null);
      return;
    }
    setLoading(true);
    fetch(`/api/mcp/catalog?cwd=${encodeURIComponent(workspaceCwd)}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.detail || t("settings.mcpPage.loadError"));
        setServers(data.servers || []);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, [t, workspaceCwd]);

  const toggle = async (id: string, on: boolean) => {
    const previous = servers.find((server) => server.id === id)?.enabled || false;
    setError(null);
    setServers((prev) => prev.map((server) => (server.id === id ? { ...server, enabled: on } : server)));
    try {
      const res = await fetch(`/api/settings/mcp/${id}?enabled=${on}`, {
        method: "PUT",
      });
      await readSettingsResponse(res, t("settings.mcpPage.updateError", { error: res.statusText }));
    } catch (cause) {
      setServers((prev) => prev.map((server) => (server.id === id ? { ...server, enabled: previous } : server)));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (loading)
    return (
      <div className="text-sm text-muted py-4">
        <Loader2 size={16} className="animate-spin inline mr-2" />
        {t("common.loading")}
      </div>
    );

  return (
    <div className="space-y-6">
      <Section title={t("settings.mcpPage.title")}>
        {error && <p className="mb-3 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}
        <p className="text-[11px] text-muted mb-3">{t("settings.mcpPage.description")}</p>
        {!workspaceCwd ? (
          <p className="rounded-input border border-dashed border-border px-3 py-3 text-xs text-muted">{t("settings.mcpPage.workspaceRequired")}</p>
        ) : servers.length === 0 ? (
          <p className="text-xs text-muted">{t("settings.mcpPage.empty")}</p>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <McpRow key={server.id} server={server} onToggle={toggle} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function McpRow({
  server,
  onToggle,
}: {
  server: {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    health: string;
    auth: string;
    data_egress: string;
    transport: string;
    tools: Array<{ name: string }>;
    terms_url?: string | null;
    privacy_url?: string | null;
    error?: string | null;
  };
  onToggle: (id: string, on: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text">{server.name}</span>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{server.transport}</span>
          </div>
          <p className="text-[11px] text-muted mt-0.5">{server.description || server.id}</p>
          <div className="flex items-center gap-2 mt-1.5">
            <span className={cn("text-[10px]", server.health === "ready" ? "text-ok" : server.health === "error" ? "text-error" : "text-muted")}>
              {t("settings.mcpPage.health")}: {server.health}
            </span>
            <span className={cn("text-[10px]", server.auth === "missing" ? "text-warn" : "text-muted")}>
              {t("settings.mcpPage.auth")}: {server.auth}
            </span>
            <span className={cn("text-[10px]", server.data_egress === "remote" ? "text-warn" : "text-muted")}>
              {t("settings.mcpPage.data")}: {server.data_egress}
            </span>
            <span className="text-[10px] text-muted">{t("settings.mcpPage.toolCount", { count: server.tools.length })}</span>
          </div>
          {server.error && <p className="mt-1 text-[10px] text-error">{server.error}</p>}
          {(server.terms_url || server.privacy_url) && (
            <div className="mt-1 flex gap-2 text-[10px]">
              {server.terms_url && (
                <a href={server.terms_url} target="_blank" className="text-link hover:underline">
                  {t("settings.mcpPage.terms")}
                </a>
              )}
              {server.privacy_url && (
                <a href={server.privacy_url} target="_blank" className="text-link hover:underline">
                  {t("settings.mcpPage.privacy")}
                </a>
              )}
            </div>
          )}
        </div>
        <button onClick={() => onToggle(server.id, !server.enabled)} className={cn("shrink-0 rounded-full px-3 py-1 text-[11px] font-medium transition-colors", server.enabled ? "bg-ok text-white" : "bg-surface-2 text-muted hover:bg-surface hover:text-text")}>
          {server.enabled ? t("settings.actions.on") : t("settings.actions.off")}
        </button>
      </div>
    </div>
  );
}

/* ── Shared ── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">{title}</h2>
      {children}
    </section>
  );
}

interface Machine {
  label: string;
  host: string;
  user: string;
  port: number;
  identity_file: string;
  scheduler: string;
}

function ComputeTab() {
  const { t } = useTranslation();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    host: "",
    label: "",
    user: "",
    port: 22,
    identity_file: "",
    scheduler: "",
  });
  const [adding, setAdding] = useState(false);
  const [probing, setProbing] = useState<Record<string, any>>({});
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/compute/machines");
      const d = await res.json();
      setMachines(d.machines || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleAdd = async () => {
    if (!form.host.trim()) return;
    setAdding(true);
    setError("");
    try {
      await fetch("/api/compute/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm({
        host: "",
        label: "",
        user: "",
        port: 22,
        identity_file: "",
        scheduler: "",
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (label: string) => {
    await fetch(`/api/compute/machines/${label}`, { method: "DELETE" });
    await load();
  };

  const handleProbe = async (machine: Machine) => {
    setProbing((p) => ({ ...p, [machine.label]: true }));
    try {
      const params = new URLSearchParams({
        host: machine.host,
        user: machine.user,
        port: String(machine.port),
        identity_file: machine.identity_file,
      });
      const res = await fetch(`/api/compute/probe?${params}`, {
        method: "POST",
      });
      const info = await res.json();
      setProbing((p) => ({ ...p, [machine.label]: info }));
    } catch (e) {
      console.error(e);
    } finally {
      setProbing((p) => ({ ...p, [machine.label]: false }));
    }
  };

  if (loading) return <div className="text-sm text-muted py-4">{t("common.loading")}</div>;

  return (
    <div className="space-y-6">
      <Section title={t("settings.computePage.title")}>
        <p className="text-[11px] text-muted mb-3">
          {t("settings.computePage.description")} {t("settings.computePage.savedTo")} <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">.pi-science/compute.json</code>.
        </p>
        <div className="rounded-card border border-border bg-surface p-4 mb-3">
          <div className="grid grid-cols-3 gap-2 mb-2">
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={t("settings.computePage.label")} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none" />
            <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder={t("settings.computePage.hostname")} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none font-mono" />
            <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder={t("settings.computePage.user")} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none" />
          </div>
          <div className="flex items-center gap-2">
            <select value={form.scheduler} onChange={(e) => setForm({ ...form, scheduler: e.target.value })} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none">
              <option value="">{t("settings.computePage.directSsh")}</option>
              <option value="slurm">Slurm</option>
            </select>
            <button onClick={handleAdd} disabled={!form.host.trim() || adding} className="rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40">
              {adding ? t("settings.computePage.adding") : t("settings.computePage.add")}
            </button>
            {error && <span className="text-xs text-error">{error}</span>}
          </div>
        </div>
        {machines.length === 0 ? (
          <p className="text-[12px] text-muted/60 italic">{t("settings.computePage.empty")}</p>
        ) : (
          machines.map((m) => (
            <div key={m.label} className="rounded-card border border-border bg-surface px-4 py-3 mb-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-text">{m.label}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted">
                    {m.user}@{m.host}:{m.port}
                  </span>
                  {m.scheduler && <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-accent">{m.scheduler}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleProbe(m)} disabled={!!probing[m.label]} className="rounded-input px-2 py-1 text-[11px] text-link hover:bg-surface-2">
                    {probing[m.label] === true ? <Loader2 size={12} className="animate-spin" /> : probing[m.label] ? t("settings.computePage.probed") : t("settings.computePage.probe")}
                  </button>
                  <button onClick={() => handleDelete(m.label)} className="rounded-input px-2 py-1 text-[11px] text-error hover:bg-error/10">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {probing[m.label] && typeof probing[m.label] === "object" && <div className="mt-2 rounded-input bg-surface-2 p-2 font-mono text-[10px] text-muted">{probing[m.label].reachable ? `Cores: ${probing[m.label].cores} · RAM: ${probing[m.label].memory} · GPUs: ${probing[m.label].gpus} · Slurm: ${probing[m.label].has_slurm ? "yes" : "no"}` : `Error: ${probing[m.label].error || "unreachable"}`}</div>}
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
