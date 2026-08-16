import { useState } from "react";
import { Check, Eye, EyeOff, Key, Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { clampThinkingLevel } from "../../lib/client/pi-science-client";
import type { AvailableModel, Provider, SettingsConfig } from "../../lib/settings";
import { ContextManagementSection } from "./ContextManagementSection";
import { CustomApiSection } from "./CustomApiSection";
import { ModelEndpointSection } from "./ModelEndpointSection";

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
    <div className="space-y-0">
      <section className="border-b border-faint">
        <div className="flex min-h-14 items-center justify-between gap-3 border-b border-faint py-2">
          <h2 className="text-[13px] font-semibold text-text">{t("settings.model.runtimeTitle")}</h2>
        </div>
        <div className="divide-y divide-faint">
          <label className="flex min-h-14 items-center justify-between gap-3 py-2">
            <span className="text-[13px] font-medium text-text">{t("settings.model.model")}</span>
            <select aria-label={t("settings.model.defaultLabel")} value={config.model || ""} disabled={(config.available_models || []).length === 0 || saving === "model"} onChange={(event) => { const nextModel = (config.available_models || []).find((model: AvailableModel) => model.id === event.target.value); void saveModel(event.target.value, clampThinkingLevel(config.thinking, nextModel?.thinking_levels || [])); }} className="w-auto min-w-[12rem] max-w-[62%] shrink-0 !border-0 !bg-transparent !shadow-none text-right text-sm text-text outline-none focus:border-accent">
              <option value="">{(config.available_models || []).length === 0 ? t("settings.model.configureFirst") : t("settings.model.select")}</option>
              {(config.available_models || []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-h-14 items-center justify-between gap-3 py-2">
            <span className="text-[13px] font-medium text-text">{t("settings.model.thinking")}</span>
            <select
              aria-label={t("settings.model.thinking")}
              value={selectedModel?.reasoning ? config.thinking : "off"}
              disabled={!selectedModel?.reasoning || saving === "model"}
              onChange={(event) => void saveModel(config.model, event.target.value)}
              className="w-auto min-w-[8rem] max-w-[62%] shrink-0 !border-0 !bg-transparent !shadow-none text-right text-sm text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:text-muted disabled:opacity-70"
            >
              {!selectedModel?.reasoning && <option value="off">{selectedModel ? t("settings.model.noReasoning") : t("settings.model.thinkingHint")}</option>}
              {selectedModel?.reasoning && thinkingLevels.map((level) => (
                <option key={level} value={level}>{t(`settings.thinking.${level}`, { defaultValue: level })}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-t border-faint py-2">
          <span className="text-[11px] text-muted">
            {t("settings.model.availableCount", {
              count: (config.available_models || []).length,
            })}
          </span>
          {selectedModel && <span className="text-[10px] text-muted">{selectedModel.capability_source}</span>}
          {(config.available_models || []).length === 0 && (
            <button type="button" onClick={focusProviderConfiguration} className="min-h-8 rounded-input px-2 text-[11px] font-medium text-accent hover:bg-accent/10">
              {t("settings.provider.configure")}
            </button>
          )}
        </div>
      </section>

      <ContextManagementSection config={config} saving={saving === "compaction"} onSave={saveCompaction} />

      <section id={providerSectionId} className="border-b border-faint">
        <div className="flex min-h-14 items-center justify-between gap-3 py-2">
          <h2 className="text-[13px] font-semibold text-text">{t("settings.provider.title")}</h2>
          {providerView === "vendors" && (
            <button type="button" disabled={availableVendors.length === 0} onClick={() => setShowVendorPicker((value) => !value)} className="flex min-h-8 items-center gap-1.5 rounded-input border border-border px-2.5 text-[11px] font-medium text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50">
              <Plus size={13} /> {t("settings.provider.addVendor")}
            </button>
          )}
        </div>
        <div className="flex border-y border-faint" role="tablist" aria-label={t("settings.provider.views")}>
            {[
              { id: "vendors", label: t("settings.provider.vendors") },
              { id: "custom", label: t("settings.provider.custom") },
            ].map((view) => (
              <button key={view.id} type="button" role="tab" aria-selected={providerView === view.id} aria-controls={`${providerSectionId}-${view.id}`} onClick={() => setProviderView(view.id as "vendors" | "custom")} className={cn("-mb-px min-h-9 border-b-2 px-3 text-[11px] font-medium", providerView === view.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>
                {view.label}
              </button>
            ))}
        </div>
        <div>
          {providerView === "vendors" ? (
            <div id={`${providerSectionId}-vendors`} role="tabpanel" aria-label={t("settings.provider.vendors")}>
              {showVendorPicker && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-input bg-surface-2 p-2">
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
                <div className="divide-y divide-faint border-y border-faint">
                  {visibleProviders.map((p: Provider) => (
                  <div key={p.id} className="min-h-14 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-[13px] font-medium text-text">{p.name}</span>
                        <span className="ml-2 font-mono text-[11px] text-muted">{p.id}</span>
                        <span className="ml-2 text-[10px] text-muted">
                          {t("settings.provider.modelCount", {
                            count: p.models.length,
                          })}
                        </span>
                      </div>
                      {p.has_key && (
                        <div className="flex items-center gap-2">
                          <span className="flex items-center gap-1 text-[10px] font-medium text-ok-text">
                            <Check size={10} /> {t("settings.provider.connected")}
                          </span>
                          <button onClick={() => deleteKey(p.id)} disabled={saving === p.id} className="flex min-h-8 items-center gap-1 rounded-input px-2 text-[11px] text-error-text hover:bg-error/10">
                            <Trash2 size={11} /> {t("common.delete")}
                          </button>
                        </div>
                      )}
                    </div>
                    {!p.has_key && (
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <div className="flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-input border border-border bg-surface-2 px-3 py-1.5">
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
                            className="min-h-8 min-w-8 text-muted hover:text-text"
                          >
                            {showKey[p.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                        <button onClick={() => saveKey(p.id)} disabled={!apiKeyInput[p.id]?.trim() || saving === p.id} className="flex min-h-10 items-center justify-center gap-1 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg disabled:opacity-40">
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
