import { useState } from "react";
import { Check, Eye, EyeOff, Key, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { clampThinkingLevel } from "../../lib/client/pi-science-client";
import type { AvailableModel, Provider, ProviderCredentialStatus, SettingsConfig } from "../../lib/settings";
import { ContextManagementSection } from "./ContextManagementSection";
import { CustomApiSection } from "./CustomApiSection";
import { ModelEndpointSection } from "./ModelEndpointSection";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

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
  const connected = config.providers.filter((provider) => isConnectedProvider(provider));
  const availableVendors = config.providers.filter((provider) => !isConnectedProvider(provider));
  const selectedProvider = config.providers.find((provider) => provider.id === providerToAdd);
  const visibleProviders = selectedProvider && !isConnectedProvider(selectedProvider) ? [...connected, selectedProvider] : connected;
  const selectedModel = (config.available_models || []).find((model) => model.id === config.model);
  const thinkingLevels = selectedModel?.thinking_levels || [];
  // The configured thinking value may predate the current model's capability
  // set (or the catalog may have been corrected by the runtime). Always clamp
  // before rendering so the menu value matches one of the actual options.
  const effectiveThinking = selectedModel?.reasoning ? clampThinkingLevel(config.thinking, thinkingLevels) : "off";
  const providerSectionId = "provider-configuration";
  const focusProviderConfiguration = () => {
    setProviderView("vendors");
    requestAnimationFrame(() => document.getElementById(providerSectionId)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-card border border-faint bg-surface-2/40">
        <div className="flex min-h-14 items-center justify-between gap-3 border-b border-faint px-4 py-2">
          <h2 className="text-[13px] font-semibold text-text">{t("settings.model.runtimeTitle")}</h2>
        </div>
        <div className="divide-y divide-faint">
          <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
            <span className="text-[13px] font-medium text-text">{t("settings.model.model")}</span>
            <SettingsSelectMenu
              ariaLabel={t("settings.model.defaultLabel")}
              value={config.model || ""}
              options={(config.available_models || []).map(modelMenuOption)}
              placeholder={(config.available_models || []).length === 0 ? t("settings.model.configureFirst") : t("settings.model.select")}
              disabled={(config.available_models || []).length === 0 || saving === "model"}
              className="min-w-[12rem]"
              searchable
              searchPlaceholder={t("settings.model.searchPlaceholder")}
              emptyMessage={t("settings.model.searchEmpty")}
              onSelect={(nextModelId) => {
                const nextModel = (config.available_models || []).find((model: AvailableModel) => model.id === nextModelId);
                void saveModel(nextModelId, clampThinkingLevel(config.thinking, nextModel?.thinking_levels || []));
              }}
            />
          </div>
          <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
            <span className="text-[13px] font-medium text-text">{t("settings.model.thinking")}</span>
            <SettingsSelectMenu
              ariaLabel={t("settings.model.thinking")}
              value={effectiveThinking}
              options={selectedModel?.reasoning ? thinkingLevels.map((level) => ({ value: level, label: t(`settings.thinking.${level}`, { defaultValue: level }) })) : [{ value: "off", label: selectedModel ? t("settings.model.noReasoning") : t("settings.model.thinkingHint") }]}
              disabled={!selectedModel?.reasoning || saving === "model"}
              className="min-w-[8rem]"
              onSelect={(level) => void saveModel(config.model, level)}
            />
          </div>
        </div>
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-t border-faint px-4 py-2">
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

      <section id={providerSectionId} className="overflow-hidden rounded-card border border-faint bg-surface-2/40">
        <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
          <h2 className="text-[13px] font-semibold text-text">{t("settings.provider.title")}</h2>
          {providerView === "vendors" && (
            <button type="button" disabled={availableVendors.length === 0} onClick={() => setShowVendorPicker((value) => !value)} className="flex min-h-8 items-center gap-1.5 rounded-input border border-border px-2.5 text-[11px] font-medium text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50">
              <Plus size={13} /> {t("settings.provider.addVendor")}
            </button>
          )}
        </div>
        <div className="flex border-y border-faint px-4" role="tablist" aria-label={t("settings.provider.views")}>
            {[
              { id: "vendors", label: t("settings.provider.vendors") },
              { id: "custom", label: t("settings.provider.custom") },
            ].map((view) => (
              <button key={view.id} type="button" role="tab" aria-selected={providerView === view.id} aria-controls={`${providerSectionId}-${view.id}`} onClick={() => setProviderView(view.id as "vendors" | "custom")} className={cn("-mb-px min-h-9 border-b-2 px-3 text-[11px] font-medium", providerView === view.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>
                {view.label}
              </button>
            ))}
        </div>
        <div className="px-4 pb-4">
          {providerView === "vendors" ? (
            <div id={`${providerSectionId}-vendors`} role="tabpanel" aria-label={t("settings.provider.vendors")}>
              {showVendorPicker && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-input bg-surface-2 p-2">
                  <SettingsSelectMenu
                    variant="field"
                    autoFocus
                    ariaLabel={t("settings.provider.chooseVendor")}
                    value={providerToAdd}
                    options={[...availableVendors]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((provider) => ({ value: provider.id, label: provider.name, hint: providerAuthHint(provider, t) }))}
                    placeholder={t("settings.provider.chooseVendor")}
                    searchable
                    searchPlaceholder={t("settings.provider.searchProvider")}
                    emptyMessage={t("settings.provider.searchEmpty")}
                    className="min-h-10 min-w-[220px] bg-surface"
                    onSelect={(next) => {
                      setProviderToAdd(next);
                      setShowVendorPicker(false);
                    }}
                  />
                  <span className="text-xs text-muted">{t("settings.provider.builtinOnly")}</span>
                </div>
              )}
              {visibleProviders.length === 0 ? (
                <p className="rounded-input border border-dashed border-border px-4 py-6 text-center text-xs text-muted">{t("settings.provider.empty")}</p>
              ) : (
                <div className="divide-y divide-faint">
                  {visibleProviders.map((p: Provider) => {
                    const status = providerStatus(p);
                    const apiKeySupported = providerApiKeySupported(p);
                    const isConfigured = status === "configured";
                    const isConnected = status === "connected";
                    const needsLogin = status === "needs_login";
                    const showDelete = isConfigured && apiKeySupported;
                    const showKeyForm = !isConfigured && !isConnected && apiKeySupported;
                    return (
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
                      {(isConfigured || isConnected) && (
                        <div className="flex items-center gap-2">
                          <span className="flex items-center gap-1 text-[10px] font-medium text-ok-text">
                            <Check size={10} /> {t("settings.provider.connected")}
                          </span>
                          {showDelete && (
                            <button onClick={() => deleteKey(p.id)} disabled={saving === p.id} className="flex min-h-8 items-center gap-1 rounded-input px-2 text-[11px] text-error-text hover:bg-error/10">
                              <Trash2 size={11} /> {t("common.delete")}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {needsLogin && (
                      <div className="mt-2 flex items-start gap-2 rounded-input border border-dashed border-border px-3 py-2.5 text-xs text-muted">
                        <Lock size={12} className="mt-0.5 shrink-0" />
                        <span>
                          <span className="font-medium text-text">{t("settings.provider.needsLogin")}</span>{" "}
                          {t("settings.provider.loginUnavailable")}
                        </span>
                      </div>
                    )}
                    {showKeyForm && (
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
                    );
                  })}
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

/** Build the dropdown option for one catalog model. Catalog labels look like
 *  `deepseek · DeepSeek V4 Flash`: the trigger and the option label show only
 *  the short model name after the separator, and the provider display name
 *  before it becomes the small menu hint. Labels without a `·` prefix stay
 *  as-is; an empty label falls back to the raw model name so the trigger
 *  never shows a bare separator or blank text. */
function modelMenuOption(model: AvailableModel): { value: string; label: string; hint?: string } {
  const separator = model.label.indexOf("·");
  if (separator >= 0) {
    const provider = model.label.slice(0, separator).trim();
    const name = model.label.slice(separator + 1).trim();
    return { value: model.id, label: name || model.model || model.label, hint: provider || undefined };
  }
  const label = model.label || model.model;
  const hint = model.provider && model.provider.toLowerCase() !== label.toLowerCase() ? model.provider : undefined;
  return { value: model.id, label, hint };
}

/** Effective credential status for a provider. Legacy responses only carry
 *  `has_key`; the dynamic fields are preferred when present. */
function providerStatus(provider: Provider): ProviderCredentialStatus {
  return provider.credential_status ?? (provider.has_key ? "configured" : "needs_key");
}

/** Legacy responses have no `auth` block; API-key input stays available. */
function providerApiKeySupported(provider: Provider): boolean {
  return provider.auth?.api_key_supported ?? true;
}

/** A provider is "connected" when it is configured with a stored/env key or
 *  already logged in through the runtime (OAuth-only with live models). */
function isConnectedProvider(provider: Provider): boolean {
  const status = providerStatus(provider);
  return status === "configured" || status === "connected";
}

/** Auth-kind hint for the vendor picker rows. Providers without an `auth`
 *  block (legacy payloads) get no hint. */
function providerAuthHint(provider: Provider, t: (key: string) => string): string | undefined {
  if (!provider.auth) return undefined;
  if (provider.auth.kind === "oauth") return t("settings.provider.authOAuth");
  if (provider.auth.kind === "api_key_or_oauth") return t("settings.provider.authBoth");
  return t("settings.provider.authApiKey");
}
