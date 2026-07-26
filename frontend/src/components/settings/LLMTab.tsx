import { useState } from "react";
import { Check, Eye, EyeOff, Key, Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { clampThinkingLevel } from "../../lib/pi-science-client";
import type { AvailableModel, Provider, SettingsConfig } from "../../lib/settings-types";
import { ContextManagementSection } from "./ContextManagementSection";
import { CustomApiSection } from "./CustomApiSection";
import { ModelEndpointSection } from "./ModelEndpointSection";
import { Section } from "./Section";

export interface LLMTabProps {
  config: SettingsConfig | null;
  apiKeyInput: Record<string, string>;
  setApiKeyInput: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  showKey: Record<string, boolean>;
  setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  saving: string | null;
  saveKey: (provider: string) => Promise<void>;
  deleteKey: (provider: string) => Promise<void>;
  saveModel: (model: string, thinking?: string) => Promise<void>;
  saveCompaction: (enabled: boolean, thresholdPercent: number) => Promise<void>;
  onConfigReload: () => Promise<void>;
}

export function LLMTab({ config, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, deleteKey, saveModel, saveCompaction, onConfigReload }: LLMTabProps) {
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
  const connected = config.providers.filter((provider) => provider.has_key);
  const availableVendors = config.providers.filter((provider) => !provider.has_key);
  const selectedProvider = config.providers.find((provider) => provider.id === providerToAdd);
  const visibleProviders = selectedProvider && !selectedProvider.has_key ? [...connected, selectedProvider] : connected;
  const selectedModel = (config.available_models || []).find((model) => model.id === config.model);
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
                {(config.available_models || []).map((model) => (
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
                  {thinkingLevels.map((level) => (
                    <button key={level} disabled={saving === "model"} onClick={() => saveModel(config.model, level)} className={cn("min-h-9 min-w-[3.5rem] flex-1 rounded-input px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-50", config.thinking === level ? "bg-surface-2 text-text shadow-sm ring-1 ring-border/70" : "text-muted hover:bg-surface-2/70 hover:text-text")}>
                      {t(`settings.thinking.${level}`, { defaultValue: level })}
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

      <ContextManagementSection config={config} saving={saving === "compaction"} onSave={saveCompaction} />

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
                    {availableVendors.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
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
                            aria-label={t("settings.provider.apiKeyLabel", { provider: p.name })}
                            type={showKey[p.id] ? "text" : "password"}
                            value={apiKeyInput[p.id] || ""}
                            onChange={(e) =>
                              setApiKeyInput((prev) => ({
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
                              setShowKey((prev) => ({
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
