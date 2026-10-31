import { SettingsSaveMode } from "./SettingsSaveMode";
import { useSettingsDraftStatus } from "./SettingsDraftStatus";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/client/api";
import { settingsApi } from "../../lib/settings";
import { SettingsToggle } from "./SettingsToggle";
import { SettingsRow } from "./SettingsRow";
import { SettingsSelectMenu } from "./SettingsSelectMenu";
import { SettingsSaveBar } from "./SettingsSaveBar";
import { Section } from "./Section";

type WebSettings = { search_enabled: boolean; fetch_enabled: boolean; provider: string; api_keys: Record<string, boolean> };
const providers = ["auto", "exa", "brave", "tavily", "perplexity", "jina", "deepseek"];

export function WebSearchTab() {
  const { t } = useTranslation();
  const [data, setData] = useState<WebSettings | null>(null);
  const [base, setBase] = useState<WebSettings | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    apiRequest<{ web_access: WebSettings }>("/api/settings/web-access")
      .then((value) => { if (active) { setData(value.web_access); setBase(value.web_access); } })
      .catch((reason) => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, []);
  const dirty = JSON.stringify(data) !== JSON.stringify(base) || Boolean(key.trim());
  useSettingsDraftStatus("web-search", dirty);
  async function save(removeKey = false) {
    if (!data) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await settingsApi.saveWebAccess<{ web_access: WebSettings }>(removeKey ? { api_keys: { [data.provider]: "" } } : {
        search_enabled: data.search_enabled, fetch_enabled: data.fetch_enabled, provider: data.provider,
        ...(data.provider !== "auto" && (removeKey || key.trim()) ? { api_keys: { [data.provider]: removeKey ? "" : key.trim() } } : {}),
      });
      setBase(result.web_access);
      if (removeKey) setData({ ...data, api_keys: result.web_access.api_keys });
      else setData(result.web_access);
      setKey(""); setSaved(!removeKey);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  function change(patch: Partial<WebSettings>) { setData((previous) => previous ? { ...previous, ...patch } : previous); setSaved(false); }
  return <div className="space-y-5">
    <SettingsSaveMode />
    <p className="text-ui-label leading-relaxed text-muted">{t("settings.webSearch.description")}</p>
    <p className="text-ui-caption text-muted">{t("settings.consistency.webDependency")}</p>
    {error && <p role="alert" className="text-ui-label text-error-text">{error}</p>}
    {!data && !error && <p role="status">{t("common.loading")}</p>}
    {data && <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Section title={t("settings.webSearch.tools")}>
        <div className="space-y-4">
          <SettingsRow label={t("settings.webSearch.searchEnabled")} inline><SettingsToggle label={t("settings.webSearch.searchEnabled")} checked={data.search_enabled} disabled={busy} onChange={(search_enabled) => change({ search_enabled })} /></SettingsRow>
          <SettingsRow label={t("settings.webSearch.fetchEnabled")} inline><SettingsToggle label={t("settings.webSearch.fetchEnabled")} checked={data.fetch_enabled} disabled={busy} onChange={(fetch_enabled) => change({ fetch_enabled })} /></SettingsRow>
        </div>
      </Section>
      {(data.search_enabled || data.fetch_enabled) && <Section title={t("settings.webSearch.provider")}>
        <SettingsRow label={t("settings.webSearch.provider")}>
          <SettingsSelectMenu variant="field" ariaLabel={t("settings.webSearch.provider")} value={data.provider} disabled={busy} onSelect={(provider) => { change({ provider }); setKey(""); }} options={providers.map((provider) => ({ value: provider, label: provider === "auto" ? t("settings.webSearch.auto") : provider === "deepseek" ? "DeepSeek" : provider === "exa" ? "Exa" : provider === "jina" ? "Jina" : provider[0]!.toUpperCase() + provider.slice(1) }))} />
        </SettingsRow>
        <p className="mt-2 text-ui-caption leading-relaxed text-muted">{t(data.provider === "deepseek" ? "settings.webSearch.deepseekHelp" : "settings.webSearch.providerHelp")}</p>
        {data.provider !== "auto" && <div className="mt-4 space-y-2">
          <label className="block text-ui-label">{t("settings.webSearch.apiKey")}<input type="password" autoComplete="new-password" value={key} disabled={busy} onChange={(event) => { setKey(event.target.value); setSaved(false); }} placeholder={t(data.api_keys[data.provider] ? "settings.webSearch.keyConfigured" : "settings.webSearch.keyEmpty")} className="mt-2 block w-full rounded-input border border-border bg-surface p-2 text-text" /></label>
          {data.api_keys[data.provider] && <button type="button" disabled={busy} onClick={() => void save(true)} className="text-ui-label text-error-text disabled:opacity-50">{t("settings.webSearch.removeKey")}</button>}
        </div>}
      </Section>}
      <SettingsSaveBar dirty={dirty} busy={busy} saved={saved} onDiscard={() => { setData(base); setKey(""); setSaved(false); }} />
    </form>}
  </div>;
}
