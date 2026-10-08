import { memo, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Ellipsis, Eye, EyeOff, Loader2, PlugZap, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../../../lib/ui";
import { Modal as AccessibleModal } from "../../ui/Modal";
import { modelResourceKeys, modelResourcesApi } from "../../../lib/model-resources";
import type { ProviderView } from "@pi-science/contracts";
import { invalidateSettings } from "../../../lib/settings";
import { buildServices, formatContext, type ModelView, type Service } from "./model-utils";
import { SettingsSelectMenu } from "../SettingsSelectMenu";

export interface AIModelsTabProps {
  scope?: string | null;
  apiKeyInput: Record<string, string>;
  setApiKeyInput: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  showKey: Record<string, boolean>;
  setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  saving: string | null;
  saveKey: (provider: string) => Promise<void>;
  deleteKey: (provider: string) => Promise<void>;
  onConfigReload?: () => Promise<void>;
}

type ConnectTarget = { id: string; name: string; kind: "builtin" | "custom" } | null;

const EMPTY_CUSTOM = { name: "", baseUrl: "", protocol: "openai" as "openai" | "anthropic" | "ollama", authKind: "api_key" as "api_key" | "none", apiKey: "" };

export function AIModelsTab({ scope = null, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, deleteKey, onConfigReload }: AIModelsTabProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectTarget, setConnectTarget] = useState<ConnectTarget>(null);
  const [manageService, setManageService] = useState<Service | null>(null);
  const [replaceService, setReplaceService] = useState<Service | null>(null);
  const [disconnectService, setDisconnectService] = useState<Service | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const inventory = useQuery({ queryKey: modelResourceKeys.providerViews(scope), queryFn: ({ signal }) => modelResourcesApi.providerViews(scope, signal), staleTime: 3000 });
  const services = useMemo(() => buildServices(inventory.data?.providers ?? []), [inventory.data]);
  const availableTargets = useMemo(() => services.filter((service) => !service.custom && !service.view.credential.configured && service.view.allowed_actions.includes("replace_credential")).map((service) => ({ id: service.id, name: service.name, kind: "builtin" as const })), [services]);
  const [filter, setFilter] = useState<"all" | "ready" | "attention">("all");

  const normalizedQuery = useDeferredValue(query.trim().toLowerCase());
  const indexedServices = useMemo(() => services.map((service) => ({ service, key: `${service.name} ${service.id}`.toLowerCase(), models: service.models.map((model) => ({ model, key: `${model.name} ${model.id}`.toLowerCase() })) })), [services]);
  const visibleServices = useMemo(() => indexedServices.flatMap(({ service, key, models }) => {
    if (filter === "ready" && service.status !== "ready" || filter === "attention" && service.status === "ready") return [];
    if (!normalizedQuery || key.includes(normalizedQuery)) return [service];
    const matches = models.filter((model) => model.key.includes(normalizedQuery)).map(({ model }) => model);
    return matches.length ? [{ ...service, models: matches }] : [];
  }), [indexedServices, normalizedQuery, filter]);
  const [servicePage, setServicePage] = useState(0);
  const currentPage = Math.min(servicePage, Math.max(0, Math.ceil(visibleServices.length / 20) - 1));
  const pageServices = visibleServices.slice(currentPage * 20, (currentPage + 1) * 20);
  useEffect(() => { setServicePage(0); }, [normalizedQuery, filter]);
  useEffect(() => {
    if (services.length > 0 && Object.keys(expanded).length === 0) setExpanded({ [services[0].id]: true });
  }, [services, expanded]);



  const openConnect = () => { setConnectTarget(null); setConnectOpen(true); };
  const closeConnect = () => { setConnectOpen(false); setConnectTarget(null); };
  const toggleService = (id: string) => setExpanded((current) => ({ ...current, [id]: !current[id] }));
  const reloadModelConfig = async () => { await invalidateSettings(); await onConfigReload?.(); };
  const runServiceAction = async (service: Service, action: () => Promise<void>) => {
    setActionBusy(service.id);
    setActionError(null);
    try { await action(); await reloadModelConfig(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setActionBusy(null); }
  };
  const refreshService = (service: Service) => void runServiceAction(service, () => service.custom ? modelResourcesApi.refreshCustomProviderModels(service.id).then(() => undefined) : Promise.resolve());
  const disableService = (service: Service) => void runServiceAction(service, () => modelResourcesApi.setCustomProviderEnabled(service.id, service.status === "disabled").then(() => undefined));
  const disconnect = async () => {
    if (!disconnectService) return;
    const service = disconnectService;
    await runServiceAction(service, () => service.custom ? modelResourcesApi.deleteCustomProvider(service.id).then(() => undefined) : deleteKey(service.id));
    setDisconnectService(null);
  };

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-ui-caption text-muted">{t("settings.models.description")}</p>
        </div>
        <button type="button" onClick={openConnect} className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg">
          <PlugZap size={14} /> {t("settings.models.connect", { defaultValue: "+ Connect" })}
        </button>
      </header>

      {inventory.isPending && <p role="status" className="text-ui-caption text-muted">{t("common.loading")}</p>}
      {inventory.error && <p role="alert" className="text-ui-caption text-error-text">{inventory.error.message}<button type="button" onClick={() => void inventory.refetch()} className="ml-2 min-h-9 px-2 text-link">{t("settings.redesign.retryLoad")}</button></p>}
      <div role="group" aria-label={t("settings.providerView.filterLabel")} className="flex flex-wrap gap-2">{(["all", "ready", "attention"] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={cn("min-h-9 rounded-input border border-border px-3 text-ui-caption", filter === value ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-hover")}>{t(`settings.providerView.filter.${value}`)}</button>)}</div>
      {services.length > 0 && <div className="flex h-10 items-center gap-2 rounded-input border border-border bg-bg px-3 focus-within:border-accent">
        <Search size={16} className="shrink-0 text-muted" />
        <input type="search" aria-label={t("settings.redesign.searchModels")} placeholder={t("settings.redesign.searchModels")} value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-ui-label text-text outline-none placeholder:text-muted" />
        {query && <button type="button" onClick={() => setQuery("")} className="text-ui-caption text-link">{t("settings.redesign.clearSearch")}</button>}
      </div>}
      <section aria-labelledby="connected-services-title" aria-busy={normalizedQuery !== query.trim().toLowerCase()}>
        <h3 id="connected-services-title" className="mb-2 text-ui-label font-medium text-text">{t("settings.models.connectedServices", { defaultValue: "Model services" })}</h3>
        {services.length === 0 && (inventory.isPending || inventory.error) ? null : services.length === 0 ? (
          <div className="border-y border-faint py-10 text-center">
            <p className="text-sm font-medium text-text">{t("settings.models.emptyTitle", { defaultValue: "No model services connected" })}</p>
            <p className="mt-1 text-ui-caption text-muted">{t("settings.models.emptyDescription", { defaultValue: "Connect an AI model service so Pi can start working." })}</p>
            <button type="button" onClick={openConnect} className="mt-4 inline-flex min-h-9 items-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg"><PlugZap size={14} /> {t("settings.models.connectService", { defaultValue: "Connect a service" })}</button>
          </div>
        ) : (
          <div className="space-y-3">
            {pageServices.map((service) => (
              <ProviderSection key={`${service.id}:${normalizedQuery}`}  service={service} expanded={expanded[service.id] === true} onToggle={() => toggleService(service.id)} onManage={() => setManageService(service)} onReplace={() => setReplaceService(service)} onRefresh={() => refreshService(service)} onDisable={() => disableService(service)} onDisconnect={() => setDisconnectService(service)} busy={actionBusy === service.id} />
            ))}
            <CatalogPagination page={currentPage} pageSize={20} total={visibleServices.length} onPage={setServicePage} label={t("settings.redesign.servicePages")} />
          </div>
        )}
      </section>

      {services.length > 0 && visibleServices.length === 0 && <p role="status" className="py-4 text-ui-caption text-muted">{t("settings.redesign.noMatchingModels")}</p>}
      {actionError && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-meta text-error-text">{actionError}</p>}
      {connectOpen && <ConnectDialog providers={inventory.data?.providers ?? []} target={connectTarget} availableTargets={availableTargets} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} onClose={closeConnect} onSelect={setConnectTarget} onConfigReload={reloadModelConfig} />}
      {replaceService && <ReplaceKeyDialog service={replaceService} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={async (id) => { await saveKey(id); await reloadModelConfig(); }} onClose={() => setReplaceService(null)} />}
      {disconnectService && <DisconnectDialog busy={actionBusy === disconnectService.id} onCancel={() => setDisconnectService(null)} onConfirm={() => void disconnect()} />}
      {manageService && <ManageConnectionDrawer service={manageService} onClose={() => setManageService(null)} onConfigReload={reloadModelConfig} />}
    </div>
  );
}

function ProviderSection({ service, expanded, onToggle, onManage, onReplace, onRefresh, onDisable, onDisconnect, busy }: { service: Service; expanded: boolean; onToggle: () => void; onManage: () => void; onReplace: () => void; onRefresh: () => void; onDisable: () => void; onDisconnect: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelPage, setModelPage] = useState(0);
  const currentPage = Math.min(modelPage, Math.max(0, Math.ceil(service.models.length / 50) - 1));
  const panelId = `models-for-${service.id}`;
  const statusText = t(`settings.providerView.status.${service.status}`);
  const statusTone = service.status === "ready" ? "text-ok-text" : service.status === "needs_key" || service.status === "invalid" || service.status === "needs_login" ? "text-warn-text" : service.status === "disabled" ? "text-muted" : "text-error-text";
  return (
    <div className="rounded-card border border-border px-4">
      <div className="flex min-h-16 items-center gap-3 py-3">
        <button type="button" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle} className="flex min-w-0 flex-1 flex-wrap items-center gap-3 rounded-input text-left outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span aria-hidden="true" className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-card bg-surface-2 text-ui-body font-medium text-muted sm:flex">{service.name.slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-ui-label font-medium text-text">{service.name}</span><span className="mt-0.5 block text-ui-meta text-muted">{service.models.length ? `${service.models.length} ${t("settings.models.models", { defaultValue: "models" })}` : t("settings.models.noModels", { defaultValue: "No models discovered" })}</span></span>
          <span className={cn("flex shrink-0 items-center gap-1.5 text-ui-meta font-medium", statusTone)}><span aria-hidden="true" className={cn("size-1.5 rounded-full", service.status === "ready" ? "bg-ok" : service.status === "needs_key" || service.status === "invalid" || service.status === "needs_login" ? "bg-warn" : service.status === "disabled" ? "bg-muted" : "bg-error")} />{statusText}</span>
          {expanded ? <ChevronDown size={16} className="shrink-0 text-muted" /> : <ChevronRight size={16} className="shrink-0 text-muted" />}
        </button>
        <div className="relative shrink-0">
          {service.view.allowed_actions.length > 0 && <button type="button" aria-label={t("settings.models.connectionSettings", { defaultValue: "Connection settings" })} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)} className="rounded-input p-2 text-muted hover:bg-surface-hover hover:text-text"><Ellipsis size={16} /></button>}
          {menuOpen && <div role="menu" className="absolute right-0 top-10 z-20 w-48 rounded-input border border-border bg-surface-raised p-1 shadow-pop">
            {service.view.allowed_actions.includes("edit") && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onManage(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-text hover:bg-surface-hover">{t("settings.models.editConnection", { defaultValue: "Edit connection" })}</button>}
            {!service.custom && service.view.allowed_actions.includes("replace_credential") && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onReplace(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-text hover:bg-surface-hover">{t("settings.models.replace", { defaultValue: "Replace API key" })}</button>}
            {service.view.allowed_actions.includes("discover") && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onRefresh(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-text hover:bg-surface-hover disabled:opacity-40">{t("settings.models.refresh", { defaultValue: "Refresh models" })}</button>}
            {(service.view.allowed_actions.includes("enable") || service.view.allowed_actions.includes("disable")) && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onDisable(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-text hover:bg-surface-hover disabled:opacity-40">{service.status === "disabled" ? t("settings.redesign.enableService") : t("settings.models.disable", { defaultValue: "Disable service" })}</button>}
            {(service.view.allowed_actions.includes("delete") || service.view.allowed_actions.includes("remove_credential")) && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onDisconnect(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-error-text hover:bg-error/10 disabled:opacity-40">{t("settings.models.disconnect", { defaultValue: "Disconnect" })}</button>}
          </div>}
        </div>
      </div>
      {service.view.allowed_actions.includes("edit") && (service.status === "needs_key" || service.status === "invalid" || service.status === "unavailable") && <div className="pb-3"><button type="button" disabled={busy} onClick={onManage} className="min-h-9 rounded-input border border-border px-3 text-ui-caption text-link hover:bg-surface-hover disabled:opacity-40">{t("settings.redesign.configureConnection")}</button></div>}
      {service.custom && service.status === "needs_login" && <p className="pb-3 text-ui-caption text-muted">{t("settings.redesign.oauthUnavailable")}</p>}
      {expanded && <div className="border-t border-faint py-3 text-ui-caption text-muted">
        <p>{t("settings.providerView.summary", { configured: service.view.routing.configured_model_count, selectable: service.view.routing.selectable_model_count })}</p>
        <p className="mt-1">{t("settings.providerView.credentialLabel")}: {t(`settings.providerView.credential.${service.view.credential.state}`)} · {t("settings.providerView.verificationNever")}</p>
        {service.view.routing.issues.map((issue) => <p key={issue.code} className="mt-1">{t(`settings.providerView.reason.${issue.code}`, { defaultValue: issue.code })}</p>)}
      </div>}
      {expanded && <div id={panelId} className="border-t border-faint pb-2 pl-3" role="region" aria-label={`${service.name} ${t("settings.models.models", { defaultValue: "models" })}`}>
        {service.models.length === 0 ? <p className="py-4 text-ui-caption text-muted">{t("settings.models.noModelsHelp", { defaultValue: "Check the endpoint or refresh the model list." })}</p> : <><div className="hidden grid-cols-2 gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_7rem_7rem_5rem] sm:gap-3 border-b border-faint py-2 pr-2 text-ui-meta font-medium text-muted"><span>{t("settings.models.modelName", { defaultValue: "Model" })}</span><span className="text-right">{t("settings.models.inputFormats", { defaultValue: "Input format" })}</span><span className="text-right">{t("settings.models.contextWindow", { defaultValue: "Context" })}</span><span className="text-right">{t("settings.models.maxOutputTokens", { defaultValue: "Max output" })}</span></div>{service.models.slice(currentPage * 50, (currentPage + 1) * 50).map((model) => <ModelRow key={model.id} model={model} />)}<CatalogPagination page={currentPage} pageSize={50} total={service.models.length} onPage={setModelPage} label={`${service.name} ${t("settings.models.models")}`} /></>}
      </div>}
    </div>
  );
}

function CatalogPagination({ page, pageSize, total, onPage, label }: { page: number; pageSize: number; total: number; onPage: (page: number) => void; label: string }) {
  const { t } = useTranslation();
  if (total <= pageSize) return null;
  return <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2 py-3 text-ui-caption text-muted">
    <span role="status">{t("settings.redesign.pageRange", { start: page * pageSize + 1, end: Math.min((page + 1) * pageSize, total), total })}</span>
    <div className="flex gap-2"><button type="button" disabled={page === 0} onClick={() => onPage(page - 1)} className="min-h-9 rounded-input border border-border px-3 text-text hover:bg-surface-hover disabled:opacity-40">{t("settings.redesign.previousPage")}</button><button type="button" disabled={(page + 1) * pageSize >= total} onClick={() => onPage(page + 1)} className="min-h-9 rounded-input border border-border px-3 text-text hover:bg-surface-hover disabled:opacity-40">{t("settings.redesign.nextPage")}</button></div>
  </nav>;
}

const ModelRow = memo(function ModelRow({ model }: { model: ModelView }) {
  const { t } = useTranslation();
  return <div className="grid min-h-12 grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_5rem] sm:gap-3 border-b border-faint py-2 pr-2 last:border-0">
    <span className="col-span-2 min-w-0 break-words text-ui-label text-text sm:col-span-1">{model.name}{model.thinkingLevels.length > 0 && <span className="mt-1 block text-ui-meta text-muted">{t("settings.redesign.supportedThinking")}: {model.thinkingLevels.map((level) => t(`settings.thinking.${level}`, { defaultValue: level })).join(" · ")}</span>}{model.source && <span className="mt-1 block text-ui-meta text-muted">{t("settings.providerView.capabilitySource")}: {t(`settings.providerView.capability.${model.source}`, { defaultValue: model.source })}</span>}{model.available === false && <span className="mt-1 block text-ui-meta text-muted">{model.reason ? t(`settings.providerView.reason.${model.reason}`, { defaultValue: model.reason }) : t("settings.redesign.modelNotAvailable")}</span>}</span>
    <span className="col-span-2 text-ui-meta text-muted sm:col-span-1 sm:text-right">{model.inputFormats.length ? model.inputFormats.map((format) => t(`settings.models.input.${format}`, { defaultValue: format })).join(" · ") : "—"}</span>
    <span className="font-mono text-ui-meta text-muted sm:text-right"><span className="font-sans sm:hidden">{t("settings.models.contextWindow")}: </span>{formatContext(model.contextWindow)}</span>
    <span className="text-right font-mono text-ui-meta text-muted"><span className="font-sans sm:hidden">{t("settings.models.maxOutputTokens")}: </span>{formatContext(model.maxOutputTokens)}</span>
  </div>;
});

function ConnectDialog({ providers, target, availableTargets, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, onClose, onSelect, onConfigReload }: { providers: ProviderView[]; target: ConnectTarget; availableTargets: Array<NonNullable<ConnectTarget>>; apiKeyInput: Record<string, string>; setApiKeyInput: React.Dispatch<React.SetStateAction<Record<string, string>>>; showKey: Record<string, boolean>; setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; saving: string | null; saveKey: (provider: string) => Promise<void>; onClose: () => void; onSelect: (target: ConnectTarget) => void; onConfigReload: () => Promise<void> }) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState(EMPTY_CUSTOM);
  const [customShowKey, setCustomShowKey] = useState(false);
  const [serviceSearch, setServiceSearch] = useState("");
  const [testResult, setTestResult] = useState<{ models: Array<{ id: string; display_name: string }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProvider = target?.kind === "builtin" ? providers.find((provider) => provider.id === target.id) : undefined;
  const updateCustom = (patch: Partial<typeof custom>) => { setCustom((current) => ({ ...current, ...patch })); setTestResult(null); };
  const runTest = async () => { if (!custom.baseUrl.trim()) return; setBusy(true); setError(null); try { setTestResult(await modelResourcesApi.testCustomProvider({ base_url: custom.baseUrl.trim(), protocol: custom.protocol, auth: custom.authKind === "api_key" ? { kind: "api_key", secret: custom.apiKey.trim() } : { kind: "none" } })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const createCustom = async () => { if (!custom.name.trim() || !custom.baseUrl.trim() || !testResult) return; setBusy(true); setError(null); try { await modelResourcesApi.createCustomProvider({ name: custom.name.trim(), base_url: custom.baseUrl.trim(), protocol: custom.protocol, auth: custom.authKind === "api_key" ? { kind: "api_key", secret: custom.apiKey.trim() } : { kind: "none" }, models: testResult.models.map((model) => model.id) }); await onConfigReload(); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const connectBuiltin = async () => { if (!target || !apiKeyInput[target.id]?.trim()) return; try { await saveKey(target.id); await onConfigReload(); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  return <Modal title={target ? (target.kind === "builtin" ? `${t("settings.models.connect", { defaultValue: "Connect" })} ${target.name}` : t("settings.models.customTitle", { defaultValue: "Connect custom service" })) : t("settings.models.connectTitle", { defaultValue: "Connect a model service" })} onClose={onClose}>
    {!target ? <div className="space-y-5"><div><Field label={t("settings.models.searchServices", { defaultValue: "Search services" })}><div className="relative"><Search size={14} className="pointer-events-none absolute left-3 top-3 text-muted" /><input autoFocus value={serviceSearch} onChange={(event) => setServiceSearch(event.target.value)} placeholder={t("settings.models.searchServicesPlaceholder", { defaultValue: "Search all model services" })} className={cn(inputClass, "pl-9")} /></div></Field><div className="mt-3 max-h-64 space-y-1 overflow-y-auto">{availableTargets.filter((item) => item.name.toLowerCase().includes(serviceSearch.trim().toLowerCase()) || item.id.toLowerCase().includes(serviceSearch.trim().toLowerCase())).map((item) => <button key={item.id} type="button" onClick={() => onSelect(item)} className="flex min-h-10 w-full items-center rounded-input border border-transparent px-3 text-left text-ui-caption text-text hover:border-border hover:bg-surface-hover">{item.name}</button>)}{availableTargets.filter((item) => item.name.toLowerCase().includes(serviceSearch.trim().toLowerCase()) || item.id.toLowerCase().includes(serviceSearch.trim().toLowerCase())).length === 0 && <p className="px-3 py-4 text-center text-ui-caption text-muted">{t("settings.models.noMatchingServices", { defaultValue: "No matching services" })}</p>}</div></div><div className="border-t border-faint pt-4"><p className="mb-2 text-ui-meta font-medium uppercase tracking-wide text-muted">{t("settings.models.custom", { defaultValue: "Custom" })}</p><button type="button" onClick={() => onSelect({ id: "custom", name: t("settings.models.customService", { defaultValue: "Custom service" }), kind: "custom" })} className="min-h-10 w-full rounded-input border border-dashed border-border px-3 text-left text-ui-caption text-text hover:bg-surface-hover">{t("settings.models.openAiCompatible", { defaultValue: "OpenAI-compatible service" })}</button></div></div> : target.kind === "builtin" && selectedProvider ? <div className="space-y-4"><p className="text-ui-caption text-muted">{t("settings.models.connectInstructions", { defaultValue: "Add credentials to make this service available to Pi." })}</p>{selectedProvider.auth?.api_key_supported !== false ? <ApiKeyField provider={selectedProvider} value={apiKeyInput[selectedProvider.id] || ""} visible={showKey[selectedProvider.id] === true} onChange={(value) => setApiKeyInput((current) => ({ ...current, [selectedProvider.id]: value }))} onToggle={() => setShowKey((current) => ({ ...current, [selectedProvider.id]: !current[selectedProvider.id] }))} /> : <p className="rounded-input bg-surface-inset px-3 py-2 text-ui-caption text-muted">{t("settings.redesign.oauthUnavailable", { defaultValue: "Subscription login is not available here. Connect an API-key provider instead." })}</p>}{error && <p role="alert" className="text-ui-caption text-error-text">{error}</p>}<button type="button" onClick={() => void connectBuiltin()} disabled={selectedProvider.auth?.api_key_supported === false || saving === selectedProvider.id || !apiKeyInput[selectedProvider.id]?.trim()} className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg disabled:opacity-40">{saving === selectedProvider.id && <Loader2 size={13} className="animate-spin" />}{t("settings.models.connectAction", { defaultValue: "Connect" })}</button></div> : <div className="space-y-3"><Field label={t("settings.resources.name", { defaultValue: "Name" })}><input value={custom.name} onChange={(event) => updateCustom({ name: event.target.value })} className={inputClass} /></Field><Field label={t("settings.resources.baseUrl", { defaultValue: "Base URL" })}><input value={custom.baseUrl} onChange={(event) => updateCustom({ baseUrl: event.target.value })} className={cn(inputClass, "font-mono")} /></Field><div className="grid gap-3 sm:grid-cols-2"><Field label={t("settings.resources.protocol", { defaultValue: "Protocol" })}><SettingsSelectMenu variant="field" ariaLabel={t("settings.resources.protocol", { defaultValue: "Protocol" })} value={custom.protocol} options={[{ value: "openai", label: t("settings.resources.openai", { defaultValue: "OpenAI-compatible" }) }, { value: "anthropic", label: t("settings.resources.anthropic", { defaultValue: "Anthropic-compatible" }) }, { value: "ollama", label: t("settings.resources.ollama", { defaultValue: "Ollama" }) }]} onSelect={(value) => updateCustom({ protocol: value as typeof custom.protocol })} /></Field><Field label={t("settings.resources.auth", { defaultValue: "Authentication" })}><SettingsSelectMenu variant="field" ariaLabel={t("settings.resources.auth", { defaultValue: "Authentication" })} value={custom.authKind} options={[{ value: "api_key", label: t("settings.resources.managedKey", { defaultValue: "API key" }) }, { value: "none", label: t("settings.resources.noAuth", { defaultValue: "No authentication" }) }]} onSelect={(value) => updateCustom({ authKind: value as typeof custom.authKind, ...(value === "none" ? { apiKey: "" } : {}) })} /></Field></div>{custom.authKind === "api_key" && <Field label={t("settings.resources.apiKey", { defaultValue: "API key" })}><SecretInput value={custom.apiKey} visible={customShowKey} onChange={(value) => updateCustom({ apiKey: value })} onToggle={() => setCustomShowKey((value) => !value)} /></Field>}<button type="button" onClick={() => void runTest()} disabled={busy || !custom.baseUrl.trim()} className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-input border border-border px-3 text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-40">{busy && <Loader2 size={13} className="animate-spin" />}{t("settings.models.testDiscover", { defaultValue: "Test & Discover" })}</button>{error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-meta text-error-text">{error}</p>}{testResult && <div className="rounded-input bg-surface-inset px-3 py-2 text-ui-caption text-ok-text"><Check size={13} className="mr-1 inline" />{t("settings.models.discovered", { defaultValue: "Connection successful: {{count}} models discovered", count: testResult.models.length })}</div>}<button type="button" onClick={() => void createCustom()} disabled={busy || !testResult || !custom.name.trim()} className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg disabled:opacity-40">{busy && <Loader2 size={13} className="animate-spin" />}{t("settings.models.addService", { defaultValue: "Add service" })}</button></div>}
  </Modal>;
}

function ReplaceKeyDialog({ service, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, onClose }: { service: Service; apiKeyInput: Record<string, string>; setApiKeyInput: React.Dispatch<React.SetStateAction<Record<string, string>>>; showKey: Record<string, boolean>; setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; saving: string | null; saveKey: (provider: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const save = async () => { setError(null); try { await saveKey(service.id); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  return <Modal title={t("settings.models.replaceKeyTitle", { defaultValue: "Replace API key" })} onClose={onClose}>
    <p className="mb-4 text-ui-caption text-muted">{service.name}</p>
    <ApiKeyField provider={service.provider!} value={apiKeyInput[service.id] || ""} visible={showKey[service.id] === true} onChange={(value) => setApiKeyInput((current) => ({ ...current, [service.id]: value }))} onToggle={() => setShowKey((current) => ({ ...current, [service.id]: !current[service.id] }))} />
    {error && <p role="alert" className="text-ui-caption text-error-text">{error}</p>}
    <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-9 rounded-input px-3 text-ui-meta text-muted hover:text-text">{t("common.cancel", { defaultValue: "Cancel" })}</button><button type="button" disabled={saving === service.id || !apiKeyInput[service.id]?.trim()} onClick={() => void save()} className="min-h-9 rounded-input bg-accent-fill px-3 text-ui-meta font-medium text-accent-fg disabled:opacity-40">{t("common.save", { defaultValue: "Save" })}</button></div>
  </Modal>;
}

function DisconnectDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return <Modal title={t("settings.models.disconnectTitle", { defaultValue: "Disconnect service" })} onClose={onCancel}>
    <p className="text-ui-caption text-text">{t("settings.models.disconnectConfirm", { defaultValue: "This removes the connection and its models. Historical conversations are not deleted." })}</p>
    <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onCancel} className="min-h-9 rounded-input px-3 text-ui-meta text-muted hover:text-text">{t("common.cancel", { defaultValue: "Cancel" })}</button><button type="button" disabled={busy} onClick={onConfirm} className="min-h-9 rounded-input bg-error/10 px-3 text-ui-meta font-medium text-error-text disabled:opacity-40">{t("settings.models.disconnect", { defaultValue: "Disconnect" })}</button></div>
  </Modal>;
}

function ManageConnectionDrawer({ service, onClose, onConfigReload }: { service: Service; onClose: () => void; onConfigReload: () => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState(service.name);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const initialAuth = service.auth?.kind === "none" ? "none" : "api_key";
  const [authKind, setAuthKind] = useState(initialAuth);
  const canEditAuth = service.auth?.api_key_supported !== false || service.auth.kind === "none";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpointRead = useQuery({ queryKey: modelResourceKeys.endpoints, queryFn: modelResourcesApi.endpoints, enabled: service.custom, staleTime: 0 });
  const bindingRead = useQuery({ queryKey: modelResourceKeys.bindings(), queryFn: () => modelResourcesApi.bindings(), enabled: service.custom, staleTime: 0 });
  const binding = bindingRead.data?.bindings.find((item) => item.provider_id === service.id || item.provider_id === `user-${service.id}`);
  const ownedEndpoints = endpointRead.data?.endpoints.filter((item) => item.owner_provider_id === service.id) ?? [];
  const endpoint = binding ? endpointRead.data?.endpoints.find((item) => item.id === binding.endpoint_id) : ownedEndpoints.length === 1 ? ownedEndpoints[0] : undefined;
  useEffect(() => { if (endpoint?.base_url) setBaseUrl(endpoint.base_url); }, [endpoint?.base_url]);
  const save = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    setBusy(true);
    setError(null);
    try { await modelResourcesApi.updateCustomProvider(service.id, { name: name.trim(), base_url: baseUrl.trim(), ...(canEditAuth && (apiKey.trim() || authKind !== initialAuth) ? { auth: authKind === "none" ? { kind: "none" } : { kind: "api_key", secret: apiKey.trim() } } : {}) }); await onConfigReload(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Modal title={t("settings.models.editConnection", { defaultValue: "Edit connection" })} onClose={onClose}>
    <div className="space-y-4"><Field label={t("settings.resources.name", { defaultValue: "Name" })}><input value={name} onChange={(event) => setName(event.target.value)} className={inputClass} /></Field><Field label={t("settings.models.baseUrl", { defaultValue: "Base URL" })}><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className={cn(inputClass, "font-mono")} /></Field>{canEditAuth && <Field label={t("settings.resources.auth")}><SettingsSelectMenu variant="field" ariaLabel={t("settings.resources.auth")} value={authKind} options={[{ value: "api_key", label: t("settings.resources.managedKey") }, { value: "none", label: t("settings.resources.noAuth") }]} onSelect={setAuthKind} /></Field>}{canEditAuth && authKind === "api_key" && <><Field label={t("settings.resources.apiKey")}><SecretInput value={apiKey} visible={showApiKey} onChange={setApiKey} onToggle={() => setShowApiKey((value) => !value)} /></Field><p className="text-ui-caption text-muted">{t("settings.redesign.keepCredential")}</p></>}{!canEditAuth && <p className="text-ui-caption text-muted">{t("settings.redesign.oauthUnavailable")}</p>}{endpoint && <DetailGroup title={t("settings.models.advanced", { defaultValue: "Advanced" })}><DetailRow label={t("settings.models.protocol", { defaultValue: "Protocol" })} value={endpoint.protocol} /><DetailRow label={t("settings.models.health", { defaultValue: "Health check" })} value={endpoint.health} /></DetailGroup>}{error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-meta text-error-text">{error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-9 rounded-input px-3 text-ui-meta text-muted hover:text-text">{t("common.cancel", { defaultValue: "Cancel" })}</button><button type="button" disabled={busy || !name.trim() || !baseUrl.trim() || canEditAuth && authKind === "api_key" && authKind !== initialAuth && !apiKey.trim()} onClick={() => void save()} className="min-h-9 rounded-input bg-accent-fill px-3 text-ui-meta font-medium text-accent-fg disabled:opacity-40">{t("common.save", { defaultValue: "Save" })}</button></div></div>
  </Modal>;
}

function ApiKeyField({ provider, value, visible, onChange, onToggle }: { provider: { id: string; name: string }; value: string; visible: boolean; onChange: (value: string) => void; onToggle: () => void }) { const { t } = useTranslation(); return <Field label={t("settings.models.apiKeyFor", { defaultValue: "{{provider}} API key", provider: provider.name })}><SecretInput value={value} visible={visible} onChange={onChange} onToggle={onToggle} /></Field>; }
function SecretInput({ value, visible, onChange, onToggle }: { value: string; visible: boolean; onChange: (value: string) => void; onToggle?: () => void }) { const { t } = useTranslation(); return <div className="flex items-center gap-1"><input type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} className={cn(inputClass, "font-mono")} />{onToggle && <button type="button" aria-label={visible ? t("settings.apiKey.hide") : t("settings.apiKey.show")} onClick={onToggle} className="-ml-10 min-h-8 min-w-8 text-muted hover:text-text">{visible ? <EyeOff size={14} /> : <Eye size={14} />}</button>}</div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block space-y-1.5 text-ui-meta font-medium text-text"><span>{label}</span>{children}</label>; }
function DetailGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section className="border-b border-faint py-4 last:border-0"><h3 className="mb-2 text-ui-meta font-medium uppercase tracking-wide text-muted">{title}</h3>{children}</section>; }
function DetailRow({ label, value }: { label: string; value: string }) { return <div className="flex items-start justify-between gap-4 py-1 text-ui-caption"><span className="text-muted">{label}</span><span className="max-w-[62%] break-words text-right text-text">{value}</span></div>; }
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) { return <AccessibleModal title={title} onClose={onClose}>{children}</AccessibleModal>; }
const inputClass = "min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 text-ui-caption text-text outline-none focus:border-accent";
