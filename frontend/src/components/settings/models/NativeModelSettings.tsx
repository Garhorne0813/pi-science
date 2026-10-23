import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Copy, Ellipsis, PlugZap, RefreshCw, Search, X } from "lucide-react";
import { SettingsSelectMenu } from "../SettingsSelectMenu";
import { apiRequest, ApiError } from "../../../lib/client/api";
import { Modal } from "../../ui/Modal";
import { SubscriptionAuthorization } from "./SubscriptionAuthorization";
import { ConnectModelService, CredentialFields } from "./ConnectModelService";
import { DiscoveryList } from "./DiscoveryList";
import { discoveryErrorCode, type DiscoveryErrorCode, type DiscoveredModel } from "./useModelDiscovery";
import type { ProviderConfig } from "@pi-science/contracts";
import { button, field, primary, send, useModelConfig, type CatalogProvider, type Configuration } from "./native-model-api";
import { formatContext, mergeDiscoveredModels, type LegacyDiscoveryPolicy, type ModelConfigEdits } from "./model-utils";
export { useModelConfig } from "./native-model-api";

type Dialog = { kind: "credential" | "details" | "disconnect" | "edit" | "refresh" | "subscription"; provider: CatalogProvider; candidates?: DiscoveredModel[] } | { kind: "connect"; revision: number };

const chip = "inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-micro text-muted";
const iconButton = "grid h-6 w-6 shrink-0 place-items-center rounded-small text-muted hover:bg-surface-hover hover:text-text";
const initials = (name: string) => name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || name.slice(0, 2).toUpperCase();
// A model id is only worth a second line when it says something the display name does not.
const sameModelId = (id: string, name: string) => id.replace(/[^a-z0-9]/gi, "").toLowerCase() === name.replace(/[^a-z0-9]/gi, "").toLowerCase();

export function NativeModelSettings({ onConfigReload }: { onConfigReload?: () => Promise<void> }) {
  const { t } = useTranslation();
  const configuration = useModelConfig();
  const client = useQueryClient();
  const catalog = useQuery({ queryKey: ["model-config", "catalog"], queryFn: () => apiRequest<{ providers: CatalogProvider[]; revision: number }>("/api/model-config/catalog"), retry: false });
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [issues, setIssues] = useState<Array<{ provider: CatalogProvider; code: DiscoveryErrorCode | "discovery_review" | "discovery_selection"; candidates?: DiscoveredModel[] }>>([]);
  const refresh = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ["model-config"] }), client.invalidateQueries({ queryKey: ["settings"] }), client.invalidateQueries({ queryKey: ["model-resources"] })]);
  };
  // Refresh re-reads the runtime catalog, then re-runs discovery for custom connections: new
  // models are appended and reported capabilities are rewritten in place. Removal stays a manual edit.
  const refreshModels = async (onlyIds?: string[]) => {
    setRefreshing(true); setNotice(null);
    let added = 0, updated = 0, pendingRuntime = false;
    const failures: typeof issues = [];
    try {
      const snapshot = await apiRequest<Configuration>("/api/model-config");
      let revision = snapshot.revision;
      const configs = { ...snapshot.config.providers };
      const eligible = (catalog.data?.providers ?? []).filter((item) => item.configured && item.allowed_actions.includes("refresh") && (!onlyIds || onlyIds.includes(item.id)));
      for (const [index, provider] of eligible.entries()) {
        if (!provider.authentication.resolved) { failures.push({ provider, code: "discovery_auth" }); continue; }
        try {
          const found = await send<{ models: DiscoveredModel[] }>(`/api/model-config/providers/${encodeURIComponent(provider.id)}/discover`, "POST", {});
          const config = configs[provider.id];
          if (!config) continue;
          const candidates = [...new Map(found.models.map((model) => [model.id, model])).values()];
          const selected = candidates.filter((model) => config.models?.some((existing) => existing.id === model.id) || model.kind === "chat");
          const merged = mergeDiscoveredModels(config.models ?? [], selected, config.modelOverrides);
          if (merged.conflicts.length) { failures.push({ provider, code: "discovery_review", candidates }); continue; }
          if (merged.added || merged.updated) {
            const next = { ...config, models: merged.models, ...(Object.keys(merged.modelOverrides).length ? { modelOverrides: merged.modelOverrides } : {}) };
            const saved = await send<{ revision?: number; runtime?: "published" | "reload_pending" }>(`/api/model-config/providers/${encodeURIComponent(provider.id)}`, "PATCH", { revision, config: next });
            configs[provider.id] = next;
            if (typeof saved?.revision === "number") revision = saved.revision;
            if (saved?.runtime === "reload_pending") pendingRuntime = true;
            added += merged.added; updated += merged.updated;
          }
          if (candidates.some((model) => (!model.kind || model.kind === "unknown") && !config.models?.some((existing) => existing.id === model.id))) failures.push({ provider, code: "discovery_selection", candidates });
        } catch (error) {
          const code = discoveryErrorCode(error);
          failures.push({ provider, code });
          if (code === "revision_conflict") { failures.push(...eligible.slice(index + 1).map((provider) => ({ provider, code }))); break; }
        }
      }
      await refresh();
      const outstanding = onlyIds ? [...issues.filter((issue) => !onlyIds.includes(issue.provider.id)), ...failures] : failures;
      setIssues(outstanding);
      setNotice(outstanding.length ? t(added || updated ? "settings.native.refreshPartial" : "settings.native.refreshFailed", { count: outstanding.length, added, updated })
        : added || updated ? `${t("settings.native.refreshedSummary", { added, updated })} ${t(pendingRuntime ? "settings.native.refreshedPending" : "settings.native.refreshedLive")}` : t("settings.native.refreshed"));
    } catch (error) { setNotice(t(`settings.native.error.${discoveryErrorCode(error)}`)); }
    finally { setRefreshing(false); }
  };
  const review = async (issue: typeof issues[number]) => {
    try {
      const current = await apiRequest<Configuration>("/api/model-config");
      const config = current.config.providers[issue.provider.id];
      if (!config) { await refresh(); return; }
      setDialog({ kind: "refresh", provider: { ...issue.provider, revision: current.revision, config }, candidates: issue.candidates });
    } catch (error) { setNotice(t(`settings.native.error.${discoveryErrorCode(error)}`)); }
  };
  const committed = async (result?: { runtime?: string }) => {
    if (dialog && "provider" in dialog) setIssues((current) => current.filter((issue) => issue.provider.id !== dialog.provider.id));
    setDialog(null);
    setNotice(t(result?.runtime === "reload_pending" ? "settings.native.reloadPending" : "settings.native.saved"));
    try { await refresh(); await onConfigReload?.(); } catch { setNotice(t("settings.native.reloadPending")); }
  };
  const failed = async (cause: unknown) => { if (cause instanceof ApiError && cause.status === 409) await refresh(); };
  const connected = (catalog.data?.providers ?? []).filter((p) => p.configured);
  const providers = connected.filter((p) => `${p.name} ${p.id} ${p.models.map((m) => m.id).join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(providers.length / 20) - 1));
  const revision = configuration.data?.revision;
  const canConnect = revision !== undefined && !configuration.error && Boolean(catalog.data) && !catalog.error;
  return <div className="space-y-5">
    <header className="flex items-start justify-between gap-4">
      <p className="text-ui-caption text-muted">{t("settings.native.scope")}</p>
    </header>
    {(catalog.isPending || configuration.isPending) && <p role="status">{t("common.loading")}</p>}
    {(catalog.error || configuration.error) && <p role="alert" className="text-ui-caption text-error-text">{catalog.error?.message ?? configuration.error?.message}<button className={`${button} ml-2`} onClick={() => void refresh()}>{t("settings.redesign.retryLoad")}</button></p>}
    {notice && <p role="status" className="text-ui-caption text-muted">{notice}</p>}
    {issues.length > 0 && <div className="space-y-2" role="alert">{issues.map((issue) => <div key={issue.provider.id} className="flex flex-wrap items-center gap-2 text-ui-caption text-warn-text"><span>{issue.provider.name}: {t(`settings.native.error.${issue.code}`)}</span>{issue.candidates ? <button className={button} disabled={refreshing} onClick={() => void review(issue)}>{t("settings.native.reviewChanges")}</button> : issue.code === "revision_conflict" ? <button className={button} disabled={refreshing} onClick={() => void refresh()}>{t("settings.redesign.retryLoad")}</button> : <button className={button} disabled={refreshing} onClick={() => void refreshModels([issue.provider.id])}>{t("settings.native.retryFailed")}</button>}</div>)}</div>}

    <section aria-labelledby="connected-services-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-card">
        <h3 id="connected-services-title" className="text-ui-label font-medium text-text">{t("settings.connections.myServices")}</h3>
        {connected.length > 0 && <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <label className="flex h-10 min-w-40 max-w-80 flex-1 items-center gap-2 rounded-input border border-border bg-bg px-3 focus-within:border-accent"><Search size={16} className="shrink-0 text-muted" /><input className="min-w-0 flex-1 bg-transparent text-ui-label text-text outline-none" aria-label={t("settings.redesign.searchModels")} placeholder={t("settings.redesign.searchModels")} value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />{search && <button type="button" className={iconButton} aria-label={t("settings.native.clearSearch")} onClick={() => { setSearch(""); setPage(0); }}><X size={14} /></button>}</label>
          <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-input border border-border text-muted hover:bg-surface-hover hover:text-text disabled:opacity-40" aria-label={t("settings.native.refresh")} title={t("settings.native.refresh")} disabled={refreshing} onClick={() => void refreshModels()}><RefreshCw size={15} className={refreshing ? "animate-spin motion-reduce:animate-none" : ""} /></button>
          <button className={`${primary} h-10 shrink-0`} disabled={!canConnect} onClick={() => setDialog({ kind: "connect", revision: revision! })}><PlugZap size={14} className="mr-1 inline" />{t("settings.models.connect")}</button>
        </div>}
      </div>
      {canConnect && connected.length === 0 && <div className="border-y border-faint py-10 text-center"><PlugZap className="mx-auto mb-3 text-muted" size={24} /><p className="text-sm font-medium text-text">{t("settings.models.emptyTitle")}</p><p className="mt-1 text-ui-caption text-muted">{t("settings.models.emptyDescription")}</p><button className={`${primary} mt-4`} onClick={() => setDialog({ kind: "connect", revision: revision! })}>{t("settings.models.connectService")}</button></div>}
      {connected.length > 0 && !providers.length && <p className="text-ui-caption text-muted">{t("settings.redesign.noMatchingModels")}</p>}
      {providers.slice(currentPage * 20, (currentPage + 1) * 20).map((provider) => <ServiceCard key={provider.id} provider={provider} search={search} open={Boolean(expanded[provider.id])} onToggle={() => setExpanded((v) => ({ ...v, [provider.id]: !v[provider.id] }))} onDialog={(kind) => { document.getElementById(`provider-actions-${provider.id}`)?.focus(); setDialog({ kind, provider }); }} dialogOpen={dialog !== null} />)}
      {providers.length > 20 && <div className="flex gap-2"><button className={button} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("settings.redesign.previousPage")}</button><button className={button} disabled={(currentPage + 1) * 20 >= providers.length} onClick={() => setPage(currentPage + 1)}>{t("settings.redesign.nextPage")}</button></div>}
    </section>
    <p className="border-t border-faint pt-3 text-ui-meta text-muted">{t("settings.native.capabilitySource")}</p>
    {dialog?.kind === "connect" && <ConnectModelService providers={catalog.data?.providers ?? []} revision={dialog.revision} onClose={() => setDialog(null)} onSaved={committed} onFailure={failed} />}
    {dialog?.kind === "subscription" && <Modal title={`${dialog.provider.name} · ${t("settings.oauth.manage")}`} restoreFocusTo={document.getElementById(`provider-actions-${dialog.provider.id}`)} onClose={() => setDialog(null)} contentClassName="h-[min(620px,calc(100dvh-32px))] w-[min(600px,calc(100vw-32px))] max-h-none"><SubscriptionAuthorization provider={dialog.provider} revision={dialog.provider.revision} onSaved={committed} onFailure={failed} /></Modal>}
    {dialog && dialog.kind !== "connect" && dialog.kind !== "subscription" && <ManageDialog key={`${dialog.kind}-${dialog.provider.id}`} dialog={dialog} config={configuration.data?.config ?? { providers: {} }} onClose={() => setDialog(null)} onSaved={committed} onFailure={failed} />}
  </div>;
}

type ServiceCardProps = { provider: CatalogProvider; search: string; open: boolean; onToggle: () => void; onDialog: (kind: "credential" | "subscription" | "edit" | "refresh" | "details" | "disconnect") => void; dialogOpen: boolean };
function ServiceCard({ provider, search, open, onToggle, onDialog, dialogOpen }: ServiceCardProps) {
  const { t } = useTranslation();
  const total = provider.models.length;
  const available = provider.models.filter((m) => m.available).length;
  const ready = available > 0 && (provider.authentication.source !== "oauth" || provider.authentication.resolved);
  const regionId = `models-${provider.id}`;
  const query = search.toLowerCase();
  const models = `${provider.name} ${provider.id}`.toLowerCase().includes(query) ? provider.models : provider.models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(query));
  return <section className="overflow-hidden rounded-card border border-border">
    <div className="flex items-center gap-3 px-3 py-3">
      <button className={iconButton} aria-label={provider.name} aria-expanded={open} {...(open ? { "aria-controls": regionId } : {})} onClick={onToggle}><ChevronRight size={16} className={`transition-transform ${open ? "rotate-90" : ""}`} /></button>
      <span aria-hidden="true" className={`grid h-10 w-10 shrink-0 place-items-center rounded-input border border-faint text-ui-label font-medium ${ready ? "bg-surface-inset text-text" : "bg-warn/10 text-warn-text"}`}>{initials(provider.name)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 break-words text-ui-label font-medium text-text">{provider.name}</p>
          <span className={chip}>{t(provider.authentication.source === "oauth" ? "settings.connections.subscription" : provider.source === "user" ? "settings.connections.customApi" : "settings.connections.api")}</span>
          {provider.authentication.source !== "oauth" && <span className={chip}>{t(`settings.native.source.${provider.authentication.source}`)}{provider.authentication.environment_variable ? `: ${provider.authentication.environment_variable}` : ""}</span>}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-meta text-muted">
          <span className={`inline-flex items-center gap-1.5 ${ready ? "" : "text-error-text"}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-ok" : "bg-error"}`} />{t(ready ? "settings.connections.ready" : "settings.connections.attention")}</span>
          <span className="tabular-nums">{total > 0 && available === total ? t("settings.native.modelsAllAvailable", { total }) : t("settings.native.modelsSomeAvailable", { available, total })}</span>
        </div>
      </div>
      <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="min-h-9 min-w-9 rounded-input text-muted hover:bg-surface-hover" id={`provider-actions-${provider.id}`} aria-label={t("settings.connections.actions", { name: provider.name })}><Ellipsis className="mx-auto" size={18} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content onCloseAutoFocus={(e) => { if (dialogOpen) e.preventDefault(); }} align="end" className="z-[120] min-w-44 rounded-card border border-border bg-surface-raised p-1 shadow-pop">
        {(["credential", "subscription", "edit", "refresh", "details", "disconnect"] as const).filter((action) => provider.allowed_actions.includes(action)).map((action) => <DropdownMenu.Item key={action} className="cursor-pointer rounded-input px-3 py-2 text-ui-caption text-text outline-none focus:bg-surface-hover" onSelect={() => onDialog(action)}>{t(action === "subscription" ? "settings.oauth.manage" : `settings.connections.${action}`)}</DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
    </div>
    {provider.config?.baseUrl && <div className="flex min-w-0 items-center gap-2 pb-2 pl-12 pr-3"><code className="min-w-0 truncate font-mono text-ui-meta text-muted">{provider.config.baseUrl}</code><CopyEndpoint url={provider.config.baseUrl} /></div>}
    {provider.authentication.restart_required && <p className="pb-2 pl-12 pr-3 text-ui-caption text-muted">{t("settings.native.restart")}</p>}
    {open && <div id={regionId} role="region" aria-label={`${provider.name} ${t("settings.models.models")}`} className="border-t border-faint"><ModelTable key={search} models={models} /></div>}
  </section>;
}

function CopyEndpoint({ url }: { url: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(url); setDone(true); window.setTimeout(() => setDone(false), 1200); } catch { /* clipboard is unavailable outside a secure context */ } };
  return <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-small px-1.5 py-0.5 text-ui-meta text-muted hover:bg-surface-hover hover:text-text" aria-label={`${t("settings.native.copyEndpoint")} ${url}`} onClick={() => void copy()}>{done ? <Check size={12} /> : <Copy size={12} />}{t(done ? "settings.native.copied" : "settings.native.copyEndpoint")}</button>;
}

function ModelTable({ models }: { models: CatalogProvider["models"] }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  return <>
    <table className="w-full table-fixed border-collapse text-ui-caption">
      <caption className="sr-only">{t("settings.native.modelList")}</caption>
      <thead><tr className="text-ui-meta text-muted">
        <th scope="col" className="px-3 py-2 text-left font-medium">{t("settings.native.colModel")}</th>
        <th scope="col" className="w-[76px] px-2 py-2 text-left font-medium">{t("settings.native.colContext")}</th>
        <th scope="col" className="w-[72px] px-2 py-2 text-left font-medium">{t("settings.native.colOutput")}</th>
        <th scope="col" className="hidden w-[60px] px-2 py-2 text-left font-medium sm:table-cell">{t("settings.native.colInput")}</th>
        <th scope="col" className="w-[64px] px-2 py-2 text-left font-medium">{t("settings.native.colThinking")}</th>
      </tr></thead>
      <tbody>{models.slice(page * 50, (page + 1) * 50).map((model) => <tr key={model.id} className="border-b border-faint last:border-0 hover:bg-surface-hover/60">
        <td className="h-10 px-3 align-middle">
          <span className="flex min-w-0 items-center gap-2"><span className={`truncate text-ui-label ${model.available ? "text-text" : "text-muted"}`}>{model.name}</span>{!model.available && <span className="shrink-0 text-ui-meta text-error-text">{t("settings.native.unavailable")}</span>}</span>
          {!sameModelId(model.id, model.name) && <span className="block truncate font-mono text-ui-meta text-muted">{model.id}</span>}
        </td>
        <td title={t(`settings.native.capabilitySource.${model.capability_sources?.contextWindow ?? "unknown"}`)} className={`h-10 px-2 align-middle text-ui-caption tabular-nums ${model.capability_sources?.contextWindow === "default" ? "italic text-muted" : "text-text"}`}>{formatContext(model.contextWindow)}</td>
        <td title={t(`settings.native.capabilitySource.${model.capability_sources?.maxTokens ?? "unknown"}`)} className={`h-10 px-2 align-middle text-ui-caption tabular-nums ${model.capability_sources?.maxTokens === "default" ? "italic text-muted" : "text-text"}`}>{formatContext(model.maxTokens ?? null)}</td>
        <td className="hidden h-10 px-2 align-middle sm:table-cell"><span className="flex gap-1">{model.input?.map((format) => <span key={format} title={`${t(`settings.native.input.${format}`)} · ${t(`settings.native.capabilitySource.${model.capability_sources?.input ?? "unknown"}`)}`} className="grid h-5 w-5 place-items-center rounded-small bg-surface-inset text-ui-micro font-medium text-muted">{format === "image" ? "I" : "T"}</span>)}</span></td>
        <td className="h-10 px-2 align-middle"><span title={[model.thinking_levels?.join(" · "), t(`settings.native.capabilitySource.${model.capability_sources?.thinkingLevelMap ?? "unknown"}`)].filter(Boolean).join(" · ")} className="text-ui-caption tabular-nums text-text">{model.thinking_levels?.length ? t("settings.native.thinkingLevels", { levels: model.thinking_levels.length }) : t("settings.native.unknown")}</span></td>
      </tr>)}</tbody>
    </table>
    {models.length > 50 && <div className="flex gap-2 px-3 py-2"><button className={button} disabled={page === 0} onClick={() => setPage(page - 1)}>{t("settings.redesign.previousPage")}</button><button className={button} disabled={(page + 1) * 50 >= models.length} onClick={() => setPage(page + 1)}>{t("settings.redesign.nextPage")}</button></div>}
  </>;
}

function ManageDialog({ dialog, config, onClose, onSaved, onFailure }: { dialog: Exclude<Dialog, { kind: "connect" | "subscription" }>; config: { providers: Record<string, ProviderConfig> }; onClose: () => void; onSaved: (result?: { runtime?: string }) => Promise<void>; onFailure: (cause: unknown) => Promise<void> }) {
  const { t } = useTranslation();
  const p = dialog.provider;
  const [source, setSource] = useState<string>(["managed", "environment", "keyless"].includes(p?.authentication.source ?? "") ? p!.authentication.source : "managed"); const [secret, setSecret] = useState(""); const [variable, setVariable] = useState(p?.authentication.environment_variable ?? "");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(p?.name ?? ""); const [url, setUrl] = useState(p?.config?.baseUrl ?? "");
  const [api, setApi] = useState<string>(p?.config?.api ?? "openai-completions"); const [models, setModels] = useState([...new Set([...(p?.config?.models?.map((m) => m.id) ?? []), ...(dialog.candidates ?? []).filter((model) => model.kind === "chat").map((model) => model.id)])].join("\n"));
  const [candidates, setCandidates] = useState<DiscoveredModel[]>(dialog.candidates ?? []);
  const [legacyPolicy, setLegacyPolicy] = useState<LegacyDiscoveryPolicy>();
  const [edits, setEdits] = useState<Record<string, ModelConfigEdits>>({});
  const [discard, setDiscard] = useState(false); const [touched, setTouched] = useState(false);
  const dirty = touched || Boolean(secret || p && (name !== p.name || url !== (p.config?.baseUrl ?? "") || models !== (p.config?.models?.map((m) => m.id).join("\n") ?? "")));
  const close = () => { if (!busy) { if (dirty) setDiscard(true); else onClose(); } };
  const run = async (action: () => Promise<{ runtime?: string }>, save = true, discovering = false) => {
    setBusy(true); setError(null);
    try { const result = await action(); if (save) { setSecret(""); await onSaved(result); } }
    catch (cause) { setError(discovering ? t(`settings.native.error.${discoveryErrorCode(cause)}`) : cause instanceof Error ? cause.message : String(cause)); await onFailure(cause); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const path = `/api/model-config/providers/${encodeURIComponent(p!.id)}`;
    if (dialog.kind === "disconnect") return send(path, "DELETE", { revision: p!.revision });
    if ((dialog.kind === "edit" || dialog.kind === "refresh")) {
      const ids = [...new Set(models.split("\n").map((s) => s.trim()).filter(Boolean))];
      const original = p!.config!;
      const merged = mergeDiscoveredModels((original.models ?? []).filter((model) => ids.includes(model.id)), candidates.filter((candidate) => ids.includes(candidate.id)), original.modelOverrides, edits, legacyPolicy);
      if (merged.conflicts.length) throw new Error(t("settings.native.error.discovery_review"));
      const next = { ...original, name, baseUrl: url, api, models: [...merged.models, ...ids.filter((id) => !merged.models.some((model) => model.id === id)).map((id) => ({ id }))], modelOverrides: Object.fromEntries(Object.entries(merged.modelOverrides).filter(([id]) => ids.includes(id))) };
      await send("/api/model-config/preview", "POST", { providers: { ...config.providers, [p!.id]: next } });
      return send(path, "PATCH", { revision: p!.revision, config: next });
    }
    return send(`${path}/credential`, "PUT", { revision: p!.revision, credential: source === "managed" ? { source, secret } : source === "environment" ? { source, environment_variable: variable } : { source } });
  });
  const conflicts = mergeDiscoveredModels(p.config?.models ?? [], candidates.filter((candidate) => models.split("\n").map((id) => id.trim()).includes(candidate.id)), p.config?.modelOverrides).conflicts;
  const title = `${p.name} · ${t(`settings.connections.${dialog.kind}`)}`;
  return <Modal title={title} onClose={close} restoreFocusTo={p ? document.getElementById(`provider-actions-${p.id}`) : undefined} footer={<div className="flex justify-end gap-2"><button className={button} disabled={busy} onClick={close}>{t("common.cancel")}</button>{dialog.kind !== "details" && <button className={primary} disabled={busy || Boolean(conflicts.length && !legacyPolicy) || dialog.kind === "credential" && (source === "managed" && !secret.trim() || source === "environment" && !variable.trim()) || (dialog.kind === "edit" || dialog.kind === "refresh") && (!models.trim() || !name.trim() || !url.trim())} onClick={() => void save()}>{t(dialog.kind === "disconnect" ? "settings.connections.disconnect" : "common.save")}</button>}</div>}>
    <div className="space-y-3 text-ui-caption text-text" onChange={() => setTouched(true)}>
      {dialog.kind === "credential" && <CredentialFields capabilities={p!.auth_capabilities} source={source} setSource={(v) => { setSource(v); setSecret(""); }} secret={secret} setSecret={setSecret} variable={variable} setVariable={setVariable} allowRemove />}
      {dialog.kind === "disconnect" && <p>{t("settings.connections.disconnectHelp", { name: p!.name })}</p>}
      {dialog.kind === "details" && <><p>{p!.id}</p><p>{p!.config?.baseUrl}</p><p>{p!.config?.api}</p><p>{t(`settings.native.source.${p!.authentication.source}`)}</p><p>{t("settings.native.discoveryHelp")}</p></>}
      {(dialog.kind === "edit" || dialog.kind === "refresh") && <><button className={button} disabled={busy} onClick={() => void run(async () => { const found = await send<{ models: DiscoveredModel[] }>(`/api/model-config/providers/${encodeURIComponent(p!.id)}/discover`, "POST", {}); const unique = [...new Map(found.models.map((model) => [model.id, model])).values()]; setCandidates(unique); setLegacyPolicy(undefined); setModels((current) => [...new Set([...current.split("\n").map((value) => value.trim()).filter(Boolean), ...unique.filter((model) => model.kind === "chat").map((model) => model.id)])].join("\n")); return {}; }, false, true)}>{t("settings.native.discover")}</button>{candidates.length > 0 && <DiscoveryList models={candidates} selected={models.split("\n").map((value) => value.trim()).filter(Boolean)} onChange={(ids) => { setModels(ids.join("\n")); setTouched(true); }} overrides={p.config?.modelOverrides} edits={edits} onEdits={(value) => { setEdits(value); setTouched(true); }} />}{conflicts.length > 0 && <fieldset className="space-y-2"><legend>{t("settings.native.error.discovery_review")}</legend><ul className="max-h-56 overflow-y-auto">{conflicts.map((change) => <li key={`${change.id}-${change.field}`} className="text-ui-meta">{change.id} · {change.field}: {JSON.stringify(change.current)} → {JSON.stringify(change.discovered)}</li>)}</ul>{(["preserve", "replace"] as const).map((policy) => <label key={policy} className="flex items-center gap-2"><input type="radio" name="legacy-discovery-policy" checked={legacyPolicy === policy} onChange={() => { setLegacyPolicy(policy); setTouched(true); }} />{t(`settings.native.legacyPolicy.${policy}`)}</label>)}</fieldset>}<p className="text-muted">{t("settings.native.discoveryHelp")}</p>{([["settings.resources.name", name, setName], ["settings.resources.baseUrl", url, setUrl]] as const).map(([label, value, update]) => <label key={label} className="block">{t(label)}<input className={field} value={value} onChange={(e) => { update(e.target.value); if (label === "settings.resources.baseUrl") { setCandidates([]); setEdits({}); setLegacyPolicy(undefined); } }} /></label>)}<div className="block"><span className="mb-1 block">{t("settings.native.api")}</span><SettingsSelectMenu variant="field" value={api} ariaLabel={t("settings.native.api")} onSelect={(value) => { setApi(value); setCandidates([]); setEdits({}); setLegacyPolicy(undefined); }} options={["openai-completions", "openai-responses", "anthropic-messages"].map((value) => ({ value, label: value }))} /></div><label className="block">{t("settings.native.manualModels")}<textarea className={field} rows={4} value={models} onChange={(e) => setModels(e.target.value)} /></label></>}
      {error && <p role="alert" className="text-error-text">{error}</p>}
      {discard && <div role="alert" className="space-y-2"><p>{t("settings.connections.discardHelp")}</p><button className={button} onClick={() => setDiscard(false)}>{t("settings.connections.keepEditing")}</button><button className={`${button} ml-2`} onClick={onClose}>{t("settings.connections.discard")}</button></div>}
    </div>
  </Modal>;
}
