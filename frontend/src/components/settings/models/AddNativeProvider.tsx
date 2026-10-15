import { useState } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../../lib/client/api";
import { Modal } from "../../ui/Modal";
const field = "min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 text-ui-caption text-text outline-none focus:border-accent";
const button = "min-h-9 rounded-input border border-border px-3 text-ui-caption text-text hover:bg-surface-hover disabled:opacity-40";
const post = <T,>(path: string, body: unknown) => apiRequest<T>(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

export function AddNativeProvider({ revision, onClose, onSaved }: { revision: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState(""); const [id, setId] = useState(""); const [url, setUrl] = useState("");
  const [api, setApi] = useState("openai-completions"); const [secret, setSecret] = useState(""); const [keyless, setKeyless] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]); const [selected, setSelected] = useState<string[]>([]);
  const [manual, setManual] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const discover = async () => {
    setBusy(true); setError(null);
    try { const result = await post<{ models: Array<{ id: string }> }>("/api/model-config/discover", { base_url: url, api, ...(secret && !keyless ? { secret } : {}) }); setCandidates(result.models.map((model) => model.id)); setSelected([]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const models = [...new Set([...selected, ...manual.split("\n").map((value) => value.trim()).filter(Boolean)])].map((model) => ({ id: model }));
      await post("/api/model-config/providers", { revision, id, config: { name, baseUrl: url, api, models },
        ...(keyless ? { credential: { source: "keyless" } } : secret ? { credential: { source: "managed", secret } } : {}) });
      setSecret(""); await onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  return <Modal title={t("settings.models.connect")} onClose={onClose}><div className="space-y-3">
    <label className="block text-ui-caption">{t("settings.resources.name")}<input value={name} onChange={(event) => setName(event.target.value)} className={field} /></label>
    <label className="block text-ui-caption">{t("settings.native.providerId")}<input value={id} onChange={(event) => setId(event.target.value)} className={field} /></label>
    <label className="block text-ui-caption">{t("settings.resources.baseUrl")}<input value={url} onChange={(event) => { setUrl(event.target.value); setCandidates([]); setSelected([]); }} className={field} /></label>
    <label className="block text-ui-caption">{t("settings.native.api")}<select value={api} onChange={(event) => { setApi(event.target.value); setCandidates([]); setSelected([]); }} className={field}>{["openai-completions", "openai-responses", "anthropic-messages"].map((value) => <option key={value}>{value}</option>)}</select></label>
    <label className="flex gap-2 text-ui-caption"><input type="checkbox" checked={keyless} onChange={(event) => { setKeyless(event.target.checked); setSecret(""); }} />{t("settings.native.source.keyless")}</label>
    {!keyless && <label className="block text-ui-caption">{t("settings.resources.apiKey")}<input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} className={field} /></label>}
    <button className={button} disabled={busy || !url} onClick={() => void discover()}>{t("settings.native.discover")}</button>
    <p className="text-ui-caption text-muted">{t("settings.native.discoveryHelp")}</p>
    <div className="max-h-64 overflow-y-auto">{candidates.map((model) => <label key={model} className="flex gap-2 text-ui-caption"><input type="checkbox" checked={selected.includes(model)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, model] : current.filter((id) => id !== model))} />{model}</label>)}</div>
    <label className="block text-ui-caption">{t("settings.native.manualModels")}<textarea rows={3} value={manual} onChange={(event) => setManual(event.target.value)} className={field} /></label>
    {error && <p role="alert" className="text-ui-caption text-error-text">{error}</p>}<button className={button} disabled={busy || !id || !url || !name || !selected.length && !manual.trim()} onClick={() => void save()}>{t("common.save")}</button>
  </div></Modal>;
}
