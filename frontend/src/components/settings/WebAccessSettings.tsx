import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Globe2, Loader2, Save, Trash2 } from "lucide-react";
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
  const [saved, setSaved] = useState(false);
  const selectedProvider = config?.providers.find((provider) => provider.id === config.provider) || null;

  const load = useCallback(async () => {
    setConfig(await queryClient.fetchQuery(webAccessQuery(t("settings.web.loadError"))));
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
      const data = await settingsApi.saveWebAccess({
        provider: config.provider,
        workflow: config.workflow,
        api_keys: keyPayload,
        remove_keys: removeKeys,
      }, t("settings.web.saveError"));
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
