import { useState } from "react";
import { useTranslation } from "react-i18next";
import { settingsApi } from "../../lib/settings-api";
import type { CustomProvider } from "../../lib/settings-types";

export function CustomApiSection({ providers, onConfigReload, isOpen, onOpen, onClose }: { providers: CustomProvider[]; onConfigReload: () => Promise<void>; isOpen: boolean; onOpen: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [reasoning, setReasoning] = useState(true);
  const [contextWindow, setContextWindow] = useState(128000);
  const [discovered, setDiscovered] = useState<CustomProvider | null>(null);
  const [busy, setBusy] = useState<"discover" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discover = async () => {
    if (!baseUrl.trim()) return;
    setBusy("discover");
    setError(null);
    try {
      const data = await settingsApi.discoverCustomProvider({
        name: name.trim() || "Custom API",
        base_url: baseUrl.trim(),
        api_key: apiKey,
        api,
      }, t("settings.custom.discoveryError"));
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
      await settingsApi.saveCustomProvider(discovered.id, {
        name: discovered.name,
        base_url: discovered.base_url,
        api_key: apiKey,
        api: discovered.api,
        models: discovered.models,
        reasoning,
        context_window: contextWindow,
      }, t("settings.custom.saveError"));
      setDiscovered(null);
      setName("");
      setBaseUrl("");
      setApiKey("");
      setReasoning(true);
      setContextWindow(128000);
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
      await settingsApi.deleteCustomProvider(id, t("settings.custom.removeError"));
      await onConfigReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const closeForm = () => {
    setName("");
    setBaseUrl("");
    setApiKey("");
    setReasoning(true);
    setContextWindow(128000);
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
              <option value="openai-completions">{t("settings.custom.api.openaiCompletions")}</option>
              <option value="openai-responses">{t("settings.custom.api.openaiResponses")}</option>
              <option value="anthropic-messages">{t("settings.custom.api.anthropicMessages")}</option>
            </select>
          </div>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className="w-full rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-input border border-border bg-surface-2 px-3 text-xs text-text">
              <input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
              {t("settings.custom.reasoning")}
            </label>
            <label className="flex min-h-11 items-center gap-2 rounded-input border border-border bg-surface-2 px-3">
              <span className="shrink-0 text-xs text-muted">{t("settings.custom.contextWindow")}</span>
              <input type="number" min={4096} step={1024} value={contextWindow} onChange={(event) => setContextWindow(Math.max(4096, Number(event.target.value) || 4096))} className="min-w-0 flex-1 bg-transparent text-right font-mono text-xs text-text outline-none" />
            </label>
          </div>
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
                <p className="mt-1 text-[10px] text-muted">{provider.reasoning ? t("settings.custom.reasoningEnabled") : t("settings.custom.reasoningDisabled")} · {t("settings.custom.tokens", { tokens: (provider.context_window || 128000).toLocaleString() })}</p>
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
