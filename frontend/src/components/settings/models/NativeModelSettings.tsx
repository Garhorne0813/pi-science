import { AddNativeProvider } from "./AddNativeProvider";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ModelConfigSnapshot, ModelConfigBackend, ProviderConfigView } from "@pi-science/contracts";
import { apiRequest } from "../../../lib/client/api";
import { Modal as AccessibleModal } from "../../ui/Modal";

type Configuration = ModelConfigSnapshot & { backend: ModelConfigBackend; providers: ProviderConfigView[] };
type CatalogProvider = ProviderConfigView & { name: string; models: Array<{ id: string; name: string; available: boolean; contextWindow: number | null; maxTokens?: number | null; thinking_levels?: string[] | null; source: string }> };
export const useModelConfig = () => useQuery({ queryKey: ["model-config"], queryFn: () => apiRequest<Configuration>("/api/model-config"), staleTime: 3000, retry: false });
const field = "min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 text-ui-caption text-text outline-none focus:border-accent";
const button = "min-h-9 rounded-input border border-border px-3 text-ui-caption text-text hover:bg-surface-hover disabled:opacity-40";
const send = <T,>(path: string, method: string, body: unknown) => apiRequest<T>(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

export function NativeModelSettings({ onConfigReload }: { onConfigReload?: () => Promise<void> }) {
  const { t } = useTranslation();
  const configuration = useModelConfig();
  const client = useQueryClient();
  const catalog = useQuery({ queryKey: ["model-config", "catalog"], queryFn: () => apiRequest<{ providers: CatalogProvider[]; revision: number }>("/api/model-config/catalog") });
  const [addingRevision, setAddingRevision] = useState<number | null>(null);
  const [editorRevision, setEditorRevision] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState<string | null>(null);
  const [credential, setCredential] = useState<ProviderConfigView | null>(null);
  const [source, setSource] = useState("managed");
  const [secret, setSecret] = useState("");
  const [variable, setVariable] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const revision = configuration.data?.revision;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try {
      const result = await action() as { runtime?: string };
      setNotice(result?.runtime === "reload_pending" ? t("settings.native.reloadPending") : t("settings.native.saved"));
      await client.invalidateQueries({ queryKey: ["model-config"] });
      await client.invalidateQueries({ queryKey: ["settings"] });
      try { await onConfigReload?.(); } catch { setNotice(t("settings.native.reloadPending")); }
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const saveCredential = async () => {
    if (!credential) return;
    const id = credential.id;
    const payload = source === "managed" ? { source, secret } : source === "environment" ? { source, environment_variable: variable } : { source };
    if (await run(() => send(`/api/model-config/providers/${encodeURIComponent(id)}/credential`, "PUT", { revision: credential.revision, credential: payload }))) {
      setCredential(null); setSecret(""); setVariable("");
    }
  };
  const providers = (catalog.data?.providers ?? []).filter((provider) => provider.id.toLowerCase().includes(search.toLowerCase()) || provider.name.toLowerCase().includes(search.toLowerCase()) || provider.models.some((model) => model.id.toLowerCase().includes(search.toLowerCase())));
  return <div className="space-y-4">
    <p className="text-ui-caption text-muted">{t("settings.native.scope")}</p>
    <button className={button} disabled={revision === undefined} onClick={() => setAddingRevision(revision ?? null)}>{t("settings.models.connect")}</button>
    {addingRevision !== null && <AddNativeProvider revision={addingRevision} onClose={() => setAddingRevision(null)} onSaved={async () => { await client.invalidateQueries({ queryKey: ["model-config"] }); try { await onConfigReload?.(); } catch { setNotice(t("settings.native.reloadPending")); } }} />}
    <div className="flex flex-wrap gap-2"><input aria-label={t("settings.redesign.searchModels")} value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} className={field} />
      <button className={button} disabled={revision === undefined} onClick={() => { setEditorRevision(revision ?? null); setEditor(JSON.stringify(configuration.data?.config ?? { providers: {} }, null, 2)); setPreviewed(false); setError(null); }}>{t("settings.native.edit")}</button></div>
    {(catalog.isPending || configuration.isPending) && <p role="status">{t("common.loading")}</p>}
    {(catalog.error || configuration.error || error) && <p role="alert" className="text-ui-caption text-error-text">{error ?? catalog.error?.message ?? configuration.error?.message}</p>}
    {(catalog.error || configuration.error) && <button className={button} onClick={() => { setError(null); void configuration.refetch(); void catalog.refetch(); }}>{t("settings.redesign.retryLoad")}</button>}
    {notice && <p role="status" className="text-ui-caption text-muted">{notice}</p>}
    {providers.slice(page * 20, (page + 1) * 20).map((provider) => <section key={provider.id} className="space-y-3 border-b border-faint py-3">
      <div className="flex flex-wrap items-center gap-3"><button className="min-h-9 text-ui-label font-medium text-text" aria-expanded={expanded === provider.id} onClick={() => { setExpanded(expanded === provider.id ? null : provider.id); }}>{provider.name}</button><span className="text-ui-caption text-muted">{provider.models.filter((model) => model.available).length} / {provider.models.length}</span>
        {provider.editable && <button className={button} onClick={() => { setCredential(provider); setSource("managed"); setSecret(""); setError(null); }}>{t("settings.resources.auth")}</button>}</div>
      <p className="text-ui-caption text-muted">{t(`settings.native.source.${provider.authentication.source}`)}{provider.authentication.environment_variable ? `: ${provider.authentication.environment_variable}` : ""} · {t(provider.authentication.resolved ? "settings.native.resolved" : "settings.native.unresolved")}</p>
      {provider.authentication.restart_required && <p className="text-ui-caption text-muted">{t("settings.native.restart")}</p>}
      {expanded === provider.id && <NativeModels key={`${provider.id}:${search}`} models={provider.models} search={provider.name.toLowerCase().includes(search.toLowerCase()) || provider.id.toLowerCase().includes(search.toLowerCase()) ? "" : search} />}
    </section>)}
    {providers.length > 20 && <div className="flex gap-2"><button className={button} disabled={page === 0} onClick={() => setPage(page - 1)}>{t("settings.redesign.previousPage")}</button><button className={button} disabled={(page + 1) * 20 >= providers.length} onClick={() => setPage(page + 1)}>{t("settings.redesign.nextPage")}</button></div>}
    {editor !== null && <AccessibleModal title={t("settings.native.edit")} onClose={() => setEditor(null)}><div className="space-y-3">
      <p className="text-ui-caption text-muted">{t("settings.native.editorHelp")}</p><textarea aria-label={t("settings.native.edit")} value={editor} onChange={(event) => { setEditor(event.target.value); setPreviewed(false); }} rows={16} className={`${field} font-mono`} />
      {error && <p role="alert" className="text-error-text">{error}</p>}
      <button className={button} disabled={busy} onClick={() => void run(async () => { await send("/api/model-config/preview", "POST", JSON.parse(editor)); setPreviewed(true); return {}; })}>{t("settings.native.validate")}</button>
      <button className={button} disabled={busy || !previewed} onClick={() => void (async () => { if (await run(() => send("/api/model-config", "PUT", { revision: editorRevision, config: JSON.parse(editor) }))) setEditor(null); })()}>{t("common.save")}</button>
    </div></AccessibleModal>}
    {credential && <AccessibleModal title={`${credential.id} · ${t("settings.resources.auth")}`} onClose={() => { setCredential(null); setSecret(""); }}><div className="space-y-3">
      <label className="block text-ui-caption">{t("settings.native.authSource")}<select className={field} value={source} onChange={(event) => setSource(event.target.value)}>{["managed", "environment", "keyless", "remove"].map((value) => <option key={value} value={value}>{t(`settings.native.source.${value}`)}</option>)}</select></label>
      {source === "managed" && <label className="block text-ui-caption">{t("settings.resources.apiKey")}<input autoComplete="new-password" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} className={field} /></label>}
      {source === "environment" && <label className="block text-ui-caption">{t("settings.native.envName")}<input value={variable} onChange={(event) => setVariable(event.target.value)} className={field} /><span>{t("settings.native.restart")}</span></label>}
      {error && <p role="alert" className="text-error-text">{error}</p>}<button className={button} disabled={busy || source === "managed" && !secret || source === "environment" && !variable} onClick={() => void saveCredential()}>{t("common.save")}</button>
    </div></AccessibleModal>}
  </div>;
}

function NativeModels({ models, search }: { models: CatalogProvider["models"]; search: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const filtered = models.filter((model) => model.id.toLowerCase().includes(search.toLowerCase()));
  return <div className="space-y-2 text-ui-caption">{filtered.slice(page * 50, (page + 1) * 50).map((model) => <div key={model.id} className="flex justify-between gap-3 text-muted"><span className="break-all">{model.name}<span className="block text-ui-meta">{t("settings.models.contextWindow")}: {model.contextWindow ?? t("settings.native.unknown")} · {t("settings.models.maxOutputTokens")}: {model.maxTokens ?? t("settings.native.unknown")}<br />{t("settings.redesign.supportedThinking")}: {model.thinking_levels?.join(" · ") ?? t("settings.native.unknown")}</span></span><span>{t(model.available ? "settings.native.selectable" : "settings.native.unavailable")}</span></div>)}{filtered.length > 50 && <div className="flex gap-2"><button className={button} disabled={page === 0} onClick={() => setPage(page - 1)}>{t("settings.redesign.previousPage")}</button><button className={button} disabled={(page + 1) * 50 >= filtered.length} onClick={() => setPage(page + 1)}>{t("settings.redesign.nextPage")}</button></div>}</div>;
}
