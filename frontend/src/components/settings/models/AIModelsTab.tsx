import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Ellipsis, Eye, EyeOff, Loader2, PlugZap, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../../../lib/ui";
import { modelResourceKeys, modelResourcesApi } from "../../../lib/model-resources";
import type { SettingsConfig } from "../../../lib/settings";
import { buildServices, formatContext, isConnected, type ModelView, type Service } from "./model-utils";
import { SettingsSelectMenu } from "../SettingsSelectMenu";

export interface AIModelsTabProps {
  config: SettingsConfig | null;
  apiKeyInput: Record<string, string>;
  setApiKeyInput: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  showKey: Record<string, boolean>;
  setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  saving: string | null;
  saveKey: (provider: string) => Promise<void>;
  deleteKey: (provider: string) => Promise<void>;
  onConfigReload: () => Promise<void>;
}

type ConnectTarget = { id: string; name: string; kind: "builtin" | "custom" } | null;

const EMPTY_CUSTOM = { name: "", baseUrl: "", protocol: "openai" as "openai" | "anthropic" | "ollama", authKind: "api_key" as "api_key" | "none", apiKey: "" };

export function AIModelsTab({ config, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, deleteKey, onConfigReload }: AIModelsTabProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectTarget, setConnectTarget] = useState<ConnectTarget>(null);
  const [manageService, setManageService] = useState<Service | null>(null);
  const [replaceService, setReplaceService] = useState<Service | null>(null);
  const [disconnectService, setDisconnectService] = useState<Service | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const services = useMemo(() => (config ? buildServices(config) : []), [config]);
  const availableTargets = useMemo(() => (config ? config.providers.filter((provider) => !provider.custom && !isConnected(provider)).map((provider) => ({ id: provider.id, name: provider.name, kind: "builtin" as const })) : []), [config]);

  useEffect(() => {
    if (services.length > 0 && Object.keys(expanded).length === 0) setExpanded({ [services[0].id]: true });
  }, [services, expanded]);

  if (!config) return <div className="text-sm text-muted">{t("common.loading")}</div>;

  const openConnect = () => { setConnectTarget(null); setConnectOpen(true); };
  const closeConnect = () => { setConnectOpen(false); setConnectTarget(null); };
  const toggleService = (id: string) => setExpanded((current) => ({ ...current, [id]: !current[id] }));
  const runServiceAction = async (service: Service, action: () => Promise<void>) => {
    setActionBusy(service.id);
    setActionError(null);
    try { await action(); await onConfigReload(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setActionBusy(null); }
  };
  const refreshService = (service: Service) => void runServiceAction(service, () => service.custom ? modelResourcesApi.refreshCustomProviderModels(service.id).then(() => undefined) : Promise.resolve());
  const disableService = (service: Service) => void runServiceAction(service, () => modelResourcesApi.setCustomProviderEnabled(service.id, false).then(() => undefined));
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

      <section aria-labelledby="connected-services-title">
        <h3 id="connected-services-title" className="mb-2 text-ui-label font-medium text-text">{t("settings.models.connectedServices", { defaultValue: "Connected services" })}</h3>
        {services.length === 0 ? (
          <div className="border-y border-faint py-10 text-center">
            <p className="text-sm font-medium text-text">{t("settings.models.emptyTitle", { defaultValue: "No model services connected" })}</p>
            <p className="mt-1 text-ui-caption text-muted">{t("settings.models.emptyDescription", { defaultValue: "Connect an AI model service so Pi can start working." })}</p>
            <button type="button" onClick={openConnect} className="mt-4 inline-flex min-h-9 items-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg"><PlugZap size={14} /> {t("settings.models.connectService", { defaultValue: "Connect a service" })}</button>
          </div>
        ) : (
          <div className="divide-y divide-faint border-y border-faint">
            {services.map((service) => (
              <ProviderSection key={service.id} service={service} expanded={expanded[service.id] === true} onToggle={() => toggleService(service.id)} onManage={() => setManageService(service)} onReplace={() => setReplaceService(service)} onRefresh={() => refreshService(service)} onDisable={() => disableService(service)} onDisconnect={() => setDisconnectService(service)} busy={actionBusy === service.id} />
            ))}
          </div>
        )}
      </section>

      {actionError && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-meta text-error-text">{actionError}</p>}
      {connectOpen && <ConnectDialog config={config} target={connectTarget} availableTargets={availableTargets} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} onClose={closeConnect} onSelect={setConnectTarget} onConfigReload={onConfigReload} />}
      {replaceService && <ReplaceKeyDialog service={replaceService} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} onClose={() => setReplaceService(null)} />}
      {disconnectService && <DisconnectDialog busy={actionBusy === disconnectService.id} onCancel={() => setDisconnectService(null)} onConfirm={() => void disconnect()} />}
      {manageService && <ManageConnectionDrawer service={manageService} onClose={() => setManageService(null)} onConfigReload={onConfigReload} />}
    </div>
  );
}

function ProviderSection({ service, expanded, onToggle, onManage, onReplace, onRefresh, onDisable, onDisconnect, busy }: { service: Service; expanded: boolean; onToggle: () => void; onManage: () => void; onReplace: () => void; onRefresh: () => void; onDisable: () => void; onDisconnect: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const panelId = `models-for-${service.id}`;
  const statusText = service.status === "connected" ? t("settings.models.status.connected", { defaultValue: "Connected" }) : service.status === "needs_key" ? t("settings.models.status.needsAuth", { defaultValue: "Needs authentication" }) : service.status === "disabled" ? t("settings.models.status.disabled", { defaultValue: "Disabled" }) : t("settings.models.status.unreachable", { defaultValue: "Unreachable" });
  const statusTone = service.status === "connected" ? "text-ok-text" : service.status === "needs_key" ? "text-warn-text" : "text-error-text";
  return (
    <div>
      <div className="flex min-h-16 items-center gap-3 py-3">
        <button type="button" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none">
          <span className="min-w-0 flex-1"><span className="block truncate text-ui-label font-medium text-text">{service.name}</span><span className="mt-0.5 block text-ui-meta text-muted">{service.models.length ? `${service.models.length} ${t("settings.models.models", { defaultValue: "models" })}` : t("settings.models.noModels", { defaultValue: "No models discovered" })}</span></span>
          <span className={cn("flex shrink-0 items-center gap-1.5 text-ui-meta font-medium", statusTone)}><span aria-hidden="true" className={cn("size-1.5 rounded-full", service.status === "connected" ? "bg-ok" : service.status === "needs_key" ? "bg-warn" : "bg-error")} />{statusText}</span>
          {expanded ? <ChevronDown size={16} className="shrink-0 text-muted" /> : <ChevronRight size={16} className="shrink-0 text-muted" />}
        </button>
        <div className="relative shrink-0">
          <button type="button" aria-label={t("settings.models.connectionSettings", { defaultValue: "Connection settings" })} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)} className="rounded-input p-2 text-muted hover:bg-surface-hover hover:text-text"><Ellipsis size={16} /></button>
          {menuOpen && <div role="menu" className="absolute right-0 top-10 z-20 w-48 rounded-input border border-border bg-surface-raised p-1 shadow-pop">
            {service.custom && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onManage(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-text hover:bg-surface-hover">{t("settings.models.editConnection", { defaultValue: "Edit connection" })}</button>}
            {!service.custom && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onReplace(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-text hover:bg-surface-hover">{t("settings.models.replace", { defaultValue: "Replace API key" })}</button>}
            <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onRefresh(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-text hover:bg-surface-hover disabled:opacity-40">{t("settings.models.refresh", { defaultValue: "Refresh models" })}</button>
            {service.custom && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onDisable(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-text hover:bg-surface-hover disabled:opacity-40">{t("settings.models.disable", { defaultValue: "Disable service" })}</button>}
            <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onDisconnect(); }} className="w-full rounded-input px-3 py-2 text-left text-ui-meta text-error-text hover:bg-error/10 disabled:opacity-40">{t("settings.models.disconnect", { defaultValue: "Disconnect" })}</button>
          </div>}
        </div>
      </div>
      {expanded && <div id={panelId} className="border-t border-faint pb-2 pl-3" role="region" aria-label={`${service.name} ${t("settings.models.models", { defaultValue: "models" })}`}>
        {service.models.length === 0 ? <p className="py-4 text-ui-caption text-muted">{t("settings.models.noModelsHelp", { defaultValue: "Check the endpoint or refresh the model list." })}</p> : <><div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem_4rem] gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_5rem] sm:gap-3 border-b border-faint py-2 pr-2 text-ui-meta font-medium text-muted"><span>{t("settings.models.modelName", { defaultValue: "Model" })}</span><span className="text-right">{t("settings.models.inputFormats", { defaultValue: "Input format" })}</span><span className="text-right">{t("settings.models.contextWindow", { defaultValue: "Context" })}</span><span className="text-right">{t("settings.models.maxOutputTokens", { defaultValue: "Max output" })}</span></div>{service.models.map((model) => <ModelRow key={model.id} model={model} />)}</>}
      </div>}
    </div>
  );
}

function ModelRow({ model }: { model: ModelView }) {
  const { t } = useTranslation();
  return <div className="grid min-h-12 grid-cols-[minmax(0,1fr)_5rem_5rem_4rem] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_5rem] sm:gap-3 border-b border-faint py-2 pr-2 last:border-0">
    <span className="min-w-0 truncate text-ui-label text-text">{model.name}</span>
    <span className="truncate text-right text-ui-meta text-muted">{model.inputFormats.map((format) => t(`settings.models.input.${format}`, { defaultValue: format })).join(" · ")}</span>
    <span className="text-right font-mono text-ui-meta text-muted">{formatContext(model.contextWindow)}</span>
    <span className="text-right font-mono text-ui-meta text-muted">{formatContext(model.maxOutputTokens)}</span>
  </div>;
}

function ConnectDialog({ config, target, availableTargets, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, onClose, onSelect, onConfigReload }: { config: SettingsConfig; target: ConnectTarget; availableTargets: Array<NonNullable<ConnectTarget>>; apiKeyInput: Record<string, string>; setApiKeyInput: React.Dispatch<React.SetStateAction<Record<string, string>>>; showKey: Record<string, boolean>; setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; saving: string | null; saveKey: (provider: string) => Promise<void>; onClose: () => void; onSelect: (target: ConnectTarget) => void; onConfigReload: () => Promise<void> }) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState(EMPTY_CUSTOM);
  const [customShowKey, setCustomShowKey] = useState(false);
  const [serviceSearch, setServiceSearch] = useState("");
  const [testResult, setTestResult] = useState<{ models: Array<{ id: string; display_name: string }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProvider = target?.kind === "builtin" ? config.providers.find((provider) => provider.id === target.id) : undefined;
  const updateCustom = (patch: Partial<typeof custom>) => { setCustom((current) => ({ ...current, ...patch })); setTestResult(null); };
  const runTest = async () => { if (!custom.baseUrl.trim()) return; setBusy(true); setError(null); try { setTestResult(await modelResourcesApi.testCustomProvider({ base_url: custom.baseUrl.trim(), protocol: custom.protocol, auth: custom.authKind === "api_key" ? { kind: "api_key", secret: custom.apiKey.trim() } : { kind: "none" } })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const createCustom = async () => { if (!custom.name.trim() || !custom.baseUrl.trim() || !testResult) return; setBusy(true); setError(null); try { await modelResourcesApi.createCustomProvider({ name: custom.name.trim(), base_url: custom.baseUrl.trim(), protocol: custom.protocol, auth: custom.authKind === "api_key" ? { kind: "api_key", secret: custom.apiKey.trim() } : { kind: "none" }, models: testResult.models.map((model) => model.id) }); await onConfigReload(); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const connectBuiltin = async () => { if (!target || !apiKeyInput[target.id]?.trim()) return; await saveKey(target.id); onClose(); };
  return <Modal title={target ? (target.kind === "builtin" ? `${t("settings.models.connect", { defaultValue: "Connect" })} ${target.name}` : t("settings.models.customTitle", { defaultValue: "Connect custom service" })) : t("settings.models.connectTitle", { defaultValue: "Connect a model service" })} onClose={onClose}>
    {!target ? <div className="space-y-5"><div><Field label={t("settings.models.searchServices", { defaultValue: "Search services" })}><div className="relative"><Search size={14} className="pointer-events-none absolute left-3 top-3 text-muted" /><input autoFocus value={serviceSearch} onChange={(event) => setServiceSearch(event.target.value)} placeholder={t("settings.models.searchServicesPlaceholder", { defaultValue: "Search connected services" })} className={cn(inputClass, "pl-9")} /></div></Field><div className="mt-3 max-h-64 space-y-1 overflow-y-auto">{availableTargets.filter((item) => item.name.toLowerCase().includes(serviceSearch.trim().toLowerCase()) || item.id.toLowerCase().includes(serviceSearch.trim().toLowerCase())).map((item) => <button key={item.id} type="button" onClick={() => onSelect(item)} className="flex min-h-10 w-full items-center rounded-input border border-transparent px-3 text-left text-ui-caption text-text hover:border-border hover:bg-surface-hover">{item.name}</button>)}{availableTargets.filter((item) => item.name.toLowerCase().includes(serviceSearch.trim().toLowerCase()) || item.id.toLowerCase().includes(serviceSearch.trim().toLowerCase())).length === 0 && <p className="px-3 py-4 text-center text-ui-caption text-muted">{t("settings.models.noMatchingServices", { defaultValue: "No matching services" })}</p>}</div></div><div className="border-t border-faint pt-4"><p className="mb-2 text-ui-meta font-medium uppercase tracking-wide text-muted">{t("settings.models.custom", { defaultValue: "Custom" })}</p><button type="button" onClick={() => onSelect({ id: "custom", name: t("settings.models.customService", { defaultValue: "Custom service" }), kind: "custom" })} className="min-h-10 w-full rounded-input border border-dashed border-border px-3 text-left text-ui-caption text-text hover:bg-surface-hover">{t("settings.models.openAiCompatible", { defaultValue: "OpenAI-compatible service" })}</button></div></div> : target.kind === "builtin" && selectedProvider ? <div className="space-y-4"><p className="text-ui-caption text-muted">{t("settings.models.connectInstructions", { defaultValue: "Add credentials to make this service available to Pi." })}</p>{selectedProvider.auth?.api_key_supported !== false ? <ApiKeyField provider={selectedProvider} value={apiKeyInput[selectedProvider.id] || ""} visible={showKey[selectedProvider.id] === true} onChange={(value) => setApiKeyInput((current) => ({ ...current, [selectedProvider.id]: value }))} onToggle={() => setShowKey((current) => ({ ...current, [selectedProvider.id]: !current[selectedProvider.id] }))} /> : <p className="rounded-input bg-surface-inset px-3 py-2 text-ui-caption text-muted">{t("settings.models.loginRequired", { defaultValue: "This service requires subscription login through the runtime." })}</p>}<button type="button" onClick={() => void connectBuiltin()} disabled={saving === selectedProvider.id || !apiKeyInput[selectedProvider.id]?.trim()} className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg disabled:opacity-40">{saving === selectedProvider.id && <Loader2 size={13} className="animate-spin" />}{t("settings.models.connectAction", { defaultValue: "Connect" })}</button></div> : <div className="space-y-3"><Field label={t("settings.resources.name", { defaultValue: "Name" })}><input value={custom.name} onChange={(event) => updateCustom({ name: event.target.value })} className={inputClass} /></Field><Field label={t("settings.resources.baseUrl", { defaultValue: "Base URL" })}><input value={custom.baseUrl} onChange={(event) => updateCustom({ baseUrl: event.target.value })} className={cn(inputClass, "font-mono")} /></Field><div className="grid gap-3 sm:grid-cols-2"><Field label={t("settings.resources.protocol", { defaultValue: "Protocol" })}><SettingsSelectMenu variant="field" ariaLabel={t("settings.resources.protocol", { defaultValue: "Protocol" })} value={custom.protocol} options={[{ value: "openai", label: t("settings.resources.openai", { defaultValue: "OpenAI-compatible" }) }, { value: "anthropic", label: t("settings.resources.anthropic", { defaultValue: "Anthropic-compatible" }) }, { value: "ollama", label: t("settings.resources.ollama", { defaultValue: "Ollama" }) }]} onSelect={(value) => updateCustom({ protocol: value as typeof custom.protocol })} /></Field><Field label={t("settings.resources.auth", { defaultValue: "Authentication" })}><SettingsSelectMenu variant="field" ariaLabel={t("settings.resources.auth", { defaultValue: "Authentication" })} value={custom.authKind} options={[{ value: "api_key", label: t("settings.resources.managedKey", { defaultValue: "API key" }) }, { value: "none", label: t("settings.resources.noAuth", { defaultValue: "No authentication" }) }]} onSelect={(value) => updateCustom({ authKind: value as typeof custom.authKind, ...(value === "none" ? { apiKey: "" } : {}) })} /></Field></div>{custom.authKind === "api_key" && <Field label={t("settings.resources.apiKey", { defaultValue: "API key" })}><SecretInput value={custom.apiKey} visible={customShowKey} onChange={(value) => updateCustom({ apiKey: value })} onToggle={() => setCustomShowKey((value) => !value)} /></Field>}<button type="button" onClick={() => void runTest()} disabled={busy || !custom.baseUrl.trim()} className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-input border border-border px-3 text-xs font-medium text-text hover:bg-surface-hover disabled:opacity-40">{busy && <Loader2 size={13} className="animate-spin" />}{t("settings.models.testDiscover", { defaultValue: "Test & Discover" })}</button>{error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-meta text-error-text">{error}</p>}{testResult && <div className="rounded-input bg-surface-inset px-3 py-2 text-ui-caption text-ok-text"><Check size={13} className="mr-1 inline" />{t("settings.models.discovered", { defaultValue: "Connection successful: {{count}} models discovered", count: testResult.models.length })}</div>}<button type="button" onClick={() => void createCustom()} disabled={busy || !testResult || !custom.name.trim()} className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg disabled:opacity-40">{busy && <Loader2 size={13} className="animate-spin" />}{t("settings.models.addService", { defaultValue: "Add service" })}</button></div>}
  </Modal>;
}

function ReplaceKeyDialog({ service, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, onClose }: { service: Service; apiKeyInput: Record<string, string>; setApiKeyInput: React.Dispatch<React.SetStateAction<Record<string, string>>>; showKey: Record<string, boolean>; setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; saving: string | null; saveKey: (provider: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation();
  const save = async () => { await saveKey(service.id); onClose(); };
  return <Modal title={t("settings.models.replaceKeyTitle", { defaultValue: "Replace API key" })} onClose={onClose}>
    <p className="mb-4 text-ui-caption text-muted">{service.name}</p>
    <ApiKeyField provider={service.provider!} value={apiKeyInput[service.id] || ""} visible={showKey[service.id] === true} onChange={(value) => setApiKeyInput((current) => ({ ...current, [service.id]: value }))} onToggle={() => setShowKey((current) => ({ ...current, [service.id]: !current[service.id] }))} />
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpointRead = useQuery({ queryKey: modelResourceKeys.endpoints, queryFn: modelResourcesApi.endpoints, enabled: service.custom, staleTime: 0 });
  const bindingRead = useQuery({ queryKey: modelResourceKeys.bindings(), queryFn: () => modelResourcesApi.bindings(), enabled: service.custom, staleTime: 0 });
  const binding = bindingRead.data?.bindings.find((item) => item.provider_id === service.id || item.provider_id === `user-${service.id}`);
  const endpoint = endpointRead.data?.endpoints.find((item) => item.id === binding?.endpoint_id);
  useEffect(() => { if (endpoint?.base_url) setBaseUrl(endpoint.base_url); }, [endpoint?.base_url]);
  const save = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    setBusy(true);
    setError(null);
    try { await modelResourcesApi.updateCustomProvider(service.id, { name: name.trim(), base_url: baseUrl.trim() }); await onConfigReload(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Modal title={t("settings.models.editConnection", { defaultValue: "Edit connection" })} onClose={onClose}>
    <div className="space-y-4"><Field label={t("settings.resources.name", { defaultValue: "Name" })}><input value={name} onChange={(event) => setName(event.target.value)} className={inputClass} /></Field><Field label={t("settings.models.baseUrl", { defaultValue: "Base URL" })}><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className={cn(inputClass, "font-mono")} /></Field>{endpoint && <DetailGroup title={t("settings.models.advanced", { defaultValue: "Advanced" })}><DetailRow label={t("settings.models.protocol", { defaultValue: "Protocol" })} value={endpoint.protocol} /><DetailRow label={t("settings.models.health", { defaultValue: "Health check" })} value={endpoint.health} /></DetailGroup>}{error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-meta text-error-text">{error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-9 rounded-input px-3 text-ui-meta text-muted hover:text-text">{t("common.cancel", { defaultValue: "Cancel" })}</button><button type="button" disabled={busy || !name.trim() || !baseUrl.trim()} onClick={() => void save()} className="min-h-9 rounded-input bg-accent-fill px-3 text-ui-meta font-medium text-accent-fg disabled:opacity-40">{t("common.save", { defaultValue: "Save" })}</button></div></div>
  </Modal>;
}

function ApiKeyField({ provider, value, visible, onChange, onToggle }: { provider: { id: string; name: string }; value: string; visible: boolean; onChange: (value: string) => void; onToggle: () => void }) { const { t } = useTranslation(); return <Field label={t("settings.models.apiKeyFor", { defaultValue: "{{provider}} API key", provider: provider.name })}><SecretInput value={value} visible={visible} onChange={onChange} onToggle={onToggle} /></Field>; }
function SecretInput({ value, visible, onChange, onToggle }: { value: string; visible: boolean; onChange: (value: string) => void; onToggle?: () => void }) { const { t } = useTranslation(); return <div className="flex items-center gap-1"><input type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} className={cn(inputClass, "font-mono")} />{onToggle && <button type="button" aria-label={visible ? t("settings.apiKey.hide") : t("settings.apiKey.show")} onClick={onToggle} className="-ml-10 min-h-8 min-w-8 text-muted hover:text-text">{visible ? <EyeOff size={14} /> : <Eye size={14} />}</button>}</div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block space-y-1.5 text-ui-meta font-medium text-text"><span>{label}</span>{children}</label>; }
function DetailGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section className="border-b border-faint py-4 last:border-0"><h3 className="mb-2 text-ui-meta font-medium uppercase tracking-wide text-muted">{title}</h3>{children}</section>; }
function DetailRow({ label, value }: { label: string; value: string }) { return <div className="flex items-start justify-between gap-4 py-1 text-ui-caption"><span className="text-muted">{label}</span><span className="max-w-[62%] break-words text-right text-text">{value}</span></div>; }
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) { return createPortal(<div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}><div role="dialog" aria-modal="true" aria-label={title} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card border border-faint bg-surface-raised p-5 shadow-pop"><header className="mb-5 flex items-center justify-between gap-3"><h2 className="text-ui-title font-medium text-text">{title}</h2><button type="button" aria-label="Close" onClick={onClose} className="rounded-input p-1.5 text-muted hover:bg-surface-hover hover:text-text"><X size={17} /></button></header>{children}</div></div>, document.body); }
const inputClass = "min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 text-ui-caption text-text outline-none focus:border-accent";
