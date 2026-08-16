import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { queryClient } from "../../lib/client/query-client";
import { settingsApi, webAccessQuery } from "../../lib/settings";
import type { WebAccessConfig } from "../../lib/settings";
import { Section } from "./Section";

export function WebAccessSettings() {
  const { t } = useTranslation();
  // The loaded config doubles as the edit draft (provider/workflow are changed in place
  // and the save response replaces it), so this read stays imperative.
  const [config, setConfig] = useState<WebAccessConfig | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProvider = config?.providers.find((provider) => provider.id === config.provider) || null;

  const load = useCallback(async () => {
    setConfig(await queryClient.fetchQuery(webAccessQuery(t("settings.web.loadError"))));
  }, [t]);

  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);

  const save = async (
    nextConfig: WebAccessConfig | null = config,
    removeKeys: string[] = [],
    includeDraftKeys = true,
  ) => {
    if (!nextConfig) return;
    const nextProvider = nextConfig.providers.find((provider) => provider.id === nextConfig.provider) || null;
    const keyPayload = includeDraftKeys && nextProvider && keys[nextProvider.id]?.trim() ? { [nextProvider.id]: keys[nextProvider.id] } : {};
    setBusy(true);
    setError(null);
    try {
      const data = await settingsApi.saveWebAccess({
        provider: nextConfig.provider,
        workflow: nextConfig.workflow,
        api_keys: keyPayload,
        remove_keys: removeKeys,
      }, t("settings.web.saveError"));
      setConfig(data);
      setKeys({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("settings.web.title")}>
      {error && (
        <p role="alert" className="mb-3 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error-text">
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
          <div className="divide-y divide-faint border-y border-faint">
            <label className="flex min-h-14 items-center justify-between gap-3 py-2">
              <span className="text-[13px] font-medium text-text">{t("settings.web.provider")}</span>
              <select
                value={config.provider}
                onChange={(event) => {
                  const nextConfig = { ...config, provider: event.target.value };
                  setConfig(nextConfig);
                  void save(nextConfig);
                }}
                className="w-auto min-w-[9rem] max-w-[62%] shrink-0 !border-0 !bg-transparent !shadow-none text-right text-sm text-text outline-none focus:border-accent"
              >
                <option value="auto">{t("settings.web.auto")}</option>
                {config.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-h-14 items-center justify-between gap-3 py-2">
              <span className="min-w-0 text-[13px] font-medium text-text">
                <span className="block">{t("settings.web.apiKey")}</span>
                {selectedProvider?.has_key && <span className="block truncate text-[10px] font-normal text-ok-text">{selectedProvider.key_source === "llm-settings" ? t("settings.web.fromLlm") : selectedProvider.key_source === "environment" ? t("settings.web.fromEnvironment") : t("settings.web.keySaved")}</span>}
              </span>
              <div className="flex min-w-0 w-[min(100%,22rem)] max-w-[62%] gap-2">
                <div className="flex min-h-10 min-w-0 flex-1 items-center rounded-input border border-border bg-surface-2 px-3">
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
                    onBlur={() => void save()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void save();
                      }
                    }}
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
                  <button type="button" aria-label={t("settings.web.removeKey")} onClick={() => void save(config, [selectedProvider.id], false)} disabled={busy} className="min-h-10 rounded-input px-3 text-error-text hover:bg-error/10">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </label>
            <label className="flex min-h-14 items-center justify-between gap-3 py-2">
              <span className="text-[13px] font-medium text-text">{t("settings.web.workflow")}</span>
              <select
                value={config.workflow}
                onChange={(event) => {
                  const nextConfig = { ...config, workflow: event.target.value };
                  setConfig(nextConfig);
                  void save(nextConfig);
                }}
                className="w-auto min-w-[9rem] max-w-[62%] shrink-0 !border-0 !bg-transparent !shadow-none text-right text-sm text-text outline-none focus:border-accent"
              >
                <option value="none">{t("settings.web.raw")}</option>
                <option value="auto-summary">{t("settings.web.autoSummary")}</option>
                <option value="summary-review">{t("settings.web.reviewSummary")}</option>
              </select>
            </label>
          </div>
        </>
      )}
    </Section>
  );
}
