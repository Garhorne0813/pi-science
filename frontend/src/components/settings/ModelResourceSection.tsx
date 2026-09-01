import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Pencil, PlugZap, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { queryClient } from "../../lib/client/query-client";
import { modelResourceKeys, modelResourcesApi } from "../../lib/model-resources";
import type { ModelEndpointResource, ModelProvider, ModelResource } from "../../lib/model-resources";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

type ProviderForm = {
  name: string;
  baseUrl: string;
  protocol: "openai" | "anthropic" | "ollama";
  authKind: "api_key" | "none";
  apiKey: string;
  allowPrivate: boolean;
};

const EMPTY_FORM: ProviderForm = { name: "", baseUrl: "", protocol: "openai", authKind: "api_key", apiKey: "", allowPrivate: false };

type TestResult = { ok: true; health: "ready"; models: Array<{ id: string; display_name: string }> };

function healthLabel(endpoint: ModelEndpointResource | undefined, t: (key: string, options?: { defaultValue?: string }) => string): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!endpoint) return { text: t("settings.resources.notTested", { defaultValue: "Not tested" }), tone: "muted" };
  if (endpoint.health === "ready") return { text: t("settings.resources.connected", { defaultValue: "Connected" }), tone: "ok" };
  if (endpoint.health === "error" || endpoint.health === "blocked") return { text: t("settings.resources.unreachable", { defaultValue: "Unreachable" }), tone: "warn" };
  return { text: t("settings.resources.notTested", { defaultValue: "Not tested" }), tone: "muted" };
}

/** Provider-centric custom provider UI: Provider cards are the primary object;
 *  add/edit goes through a test-then-confirm modal; endpoint enable/disable
 *  stays in the advanced connections section. */
export function ModelResourceSection({ onConfigReload }: { onConfigReload: () => Promise<void> }) {
  const { t } = useTranslation();
  const [modal, setModal] = useState<null | { mode: "create" } | { mode: "edit"; provider: ModelProvider }>(null);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<ModelProvider | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState<string | null>(null);
  const providersRead = useQuery({ queryKey: modelResourceKeys.providers, queryFn: modelResourcesApi.providers, staleTime: 0 });
  const endpointsRead = useQuery({ queryKey: modelResourceKeys.endpoints, queryFn: modelResourcesApi.endpoints, staleTime: 0 });
  const bindingsRead = useQuery({ queryKey: modelResourceKeys.bindings(), queryFn: () => modelResourcesApi.bindings(), staleTime: 0 });
  const modelsRead = useQuery({ queryKey: modelResourceKeys.models(), queryFn: () => modelResourcesApi.models(), staleTime: 0 });
  const providers = (providersRead.data?.providers ?? []).filter((provider) => provider.kind === "user");
  const endpoints = endpointsRead.data?.endpoints ?? [];
  const bindings = bindingsRead.data?.bindings ?? [];
  const allModels = modelsRead.data?.models ?? [];

  const connectionFor = (providerId: string): ModelEndpointResource | undefined => {
    const binding = bindings.find((item) => item.provider_id === providerId);
    return binding ? endpoints.find((item) => item.id === binding.endpoint_id) : undefined;
  };
  const modelsFor = (providerId: string): ModelResource[] => allModels.filter((model) => model.provider_id === providerId);
  const protocolLabel = (protocol: string): string =>
    protocol === "anthropic" ? t("settings.resources.anthropic", { defaultValue: "Anthropic-compatible" })
      : protocol === "ollama" ? t("settings.resources.ollama", { defaultValue: "Ollama" })
      : t("settings.resources.openai", { defaultValue: "OpenAI-compatible" });
  const editingModels = useMemo(() => (modal?.mode === "edit" ? modelsFor(modal.provider.id).sort((a, b) => a.model_id.localeCompare(b.model_id)) : []), [modal, allModels, providersRead.data]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: modelResourceKeys.providers }),
      queryClient.invalidateQueries({ queryKey: modelResourceKeys.endpoints }),
      queryClient.invalidateQueries({ queryKey: modelResourceKeys.models() }),
      queryClient.invalidateQueries({ queryKey: modelResourceKeys.bindings() }),
    ]);
  };

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setTestResult(null);
    setSelectedModels(new Set());
    setError(null);
    setModal({ mode: "create" });
  };

  const openEdit = (provider: ModelProvider) => {
    const connection = connectionFor(provider.id);
    const protocol = provider.adapter === "anthropic-compatible" ? "anthropic" : provider.adapter === "ollama" ? "ollama" : "openai";
    setForm({ name: provider.name, baseUrl: connection?.base_url ?? "", protocol, authKind: provider.auth_kind === "none" ? "none" : "api_key", apiKey: "", allowPrivate: connection?.network_policy?.allow_private === true });
    setTestResult(null);
    if (modal?.mode === "edit" && modal.provider.id === provider.id) {
      // Keep the previous selection when the modal is already open for it.
    } else {
      setSelectedModels(new Set(modelsFor(provider.id).filter((model) => model.enabled).map((model) => model.model_id)));
    }
    setError(null);
    setModal({ mode: "edit", provider });
  };

  const invalidateTestResult = () => {
    setTestResult(null);
    if (modal?.mode === "edit") setSelectedModels(new Set(modelsFor(modal.provider.id).filter((model) => model.enabled).map((model) => model.model_id)));
    else setSelectedModels(new Set());
  };

  const runTest = async () => {
    if (!form.baseUrl.trim()) return;
    setBusy("test");
    setError(null);
    try {
      const result = await modelResourcesApi.testCustomProvider({
        base_url: form.baseUrl.trim(),
        protocol: form.protocol,
        allow_private: form.allowPrivate,
        auth: form.authKind === "api_key" ? { kind: "api_key", secret: form.apiKey.trim() } : { kind: "none" },
      });
      setTestResult(result);
      setSelectedModels(new Set(result.models.map((model) => model.id)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!form.name.trim() || !form.baseUrl.trim()) return;
    const needsKey = form.authKind === "api_key" && (modal?.mode === "create" || modal?.mode === "edit" && modal.provider.auth_kind === "none");
    if (needsKey && !form.apiKey.trim()) {
      setError(t("settings.resources.keyRequired", { defaultValue: "Enter an API key or choose No authentication." }));
      return;
    }
    setBusy("save");
    setError(null);
    try {
      if (modal?.mode === "create") {
        const result = await modelResourcesApi.createCustomProvider({
          name: form.name.trim(),
          base_url: form.baseUrl.trim(),
          protocol: form.protocol,
          allow_private: form.allowPrivate,
          auth: form.authKind === "api_key" ? { kind: "api_key", secret: form.apiKey.trim() } : { kind: "none" },
          models: testResult ? [...selectedModels] : undefined,
        });
        if (result.discovery_error) setError(result.discovery_error);
      } else if (modal?.mode === "edit") {
        const auth = form.authKind === "none"
          ? modal.provider.auth_kind === "none" ? {} : { auth: { kind: "none" as const } }
          : form.apiKey.trim() ? { auth: { kind: "api_key" as const, secret: form.apiKey.trim() } } : {};
        await modelResourcesApi.updateCustomProvider(modal.provider.id, {
          name: form.name.trim(),
          base_url: form.baseUrl.trim(),
          allow_private: form.allowPrivate,
          ...auth,
        });
        if (testResult) {
          await modelResourcesApi.updateCustomProviderModels(modal.provider.id, { enabled: [...selectedModels] });
        }
      }
      setModal(null);
      await invalidate();
      await onConfigReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleModel = (id: string) => {
    setSelectedModels((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const refreshModels = async (provider: ModelProvider) => {
    setBusy(`refresh:${provider.id}`);
    setError(null);
    try {
      await modelResourcesApi.refreshCustomProviderModels(provider.id);
      await invalidate();
      await onConfigReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const setProviderEnabled = async (provider: ModelProvider, enabled: boolean) => {
    setBusy(`enabled:${provider.id}`);
    setError(null);
    try {
      await modelResourcesApi.setCustomProviderEnabled(provider.id, enabled);
      await invalidate();
      await onConfigReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const removeProvider = async (provider: ModelProvider) => {
    setBusy(`delete:${provider.id}`);
    setError(null);
    try {
      await modelResourcesApi.deleteCustomProvider(provider.id);
      await invalidate();
      await onConfigReload();
      if (modal?.mode === "edit" && modal.provider.id === provider.id) setModal(null);
      setConfirmDelete(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleEndpoint = async (endpoint: ModelEndpointResource) => {
    setBusy(`endpoint:${endpoint.id || endpoint.endpoint_id || "?"}`);
    setError(null);
    try {
      await modelResourcesApi.setEndpointEnabled(endpoint.id || endpoint.endpoint_id || "", !endpoint.enabled);
      await invalidate();
      await onConfigReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const removeEndpoint = async (endpoint: ModelEndpointResource) => {
    const id = endpoint.id || endpoint.endpoint_id || "";
    setBusy(`endpoint:${id}`);
    setError(null);
    try {
      await modelResourcesApi.deleteEndpoint(id);
      await invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const probeEndpoint = async (endpoint: ModelEndpointResource) => {
    const id = endpoint.id || endpoint.endpoint_id || "";
    setBusy(`probe:${id}`);
    setError(null);
    try {
      await modelResourcesApi.probeEndpoint(id);
      await invalidate();
      await onConfigReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-card border border-faint bg-surface-2/40">
      <div className="flex min-h-12 items-center gap-3 px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-text">{t("settings.resources.title", { defaultValue: "Providers and API connections" })}</h2>
          <p className="mt-0.5 text-[11px] text-muted">{t("settings.resources.description", { defaultValue: "A provider is the model service; adding one creates its connection, key, and models." })}</p>
        </div>
        {(providers.length > 0 || endpoints.length > 0) && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted">{providers.length + endpoints.length}</span>}
      </div>
      <div className="space-y-4 border-t border-faint px-4 py-3">
          {error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-[11px] text-error-text">{error}</p>}

          {providers.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-input border border-dashed border-faint py-6 text-center">
              <p className="text-xs text-muted">{t("settings.resources.noProviders", { defaultValue: "No custom providers yet." })}</p>
              <button type="button" onClick={openCreate} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent-fill px-3 py-2 text-xs font-medium text-accent-fg">
                <Plus size={12} />
                {t("settings.resources.addProvider", { defaultValue: "Add Provider" })}
              </button>
            </div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {providers.map((provider: ModelProvider) => {
                  const connection = connectionFor(provider.id);
                  const health = healthLabel(connection, t);
                  const models = modelsFor(provider.id);
                  return (
                    <div key={provider.id} className={cn("flex flex-col gap-2 rounded-input border border-faint p-3", !provider.enabled && "opacity-60")}>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text">{provider.name}</span>
                        <span className={cn("flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px]", health.tone === "ok" ? "bg-ok/10 text-ok-text" : health.tone === "warn" ? "bg-error/10 text-error-text" : "bg-surface-2 text-muted")}>
                          <span className={cn("size-1.5 rounded-full", health.tone === "ok" ? "bg-ok" : health.tone === "warn" ? "bg-error" : "bg-muted")} />
                          {health.text}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted">{protocolLabel(provider.adapter)}</p>
                      <p className="truncate font-mono text-[11px] text-text">{connection?.base_url ?? provider.id}</p>
                      <div className="flex items-center gap-2 text-[10px] text-muted">
                        <span>{models.length} {t("settings.resources.models", { defaultValue: "models" })}</span>
                        <span className={provider.credential_status === "configured" || provider.credential_status === "connected" ? "text-ok-text" : "text-muted"}>
                          {provider.credential_status === "configured" || provider.credential_status === "connected" ? `API key ✓` : t("settings.resources.needsKey", { defaultValue: "needs key" })}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => { if (connection) void probeEndpoint(connection); }} disabled={busy !== null || !connection} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 py-1 text-[11px] text-text hover:bg-surface-2 disabled:opacity-40">
                          <PlugZap size={11} />
                          {t("settings.resources.test", { defaultValue: "Test" })}
                        </button>
                        <button type="button" onClick={() => openEdit(provider)} disabled={busy !== null} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 py-1 text-[11px] text-text hover:bg-surface-2 disabled:opacity-40">
                          <Pencil size={11} />
                          {t("common.edit", { defaultValue: "Edit" })}
                        </button>
                        <button type="button" onClick={() => setMoreOpen(moreOpen === provider.id ? null : provider.id)} disabled={busy !== null} className="min-h-8 rounded-input px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40">
                          {t("settings.resources.more", { defaultValue: "More" })}
                        </button>
                      </div>
                      {moreOpen === provider.id && (
                        <div className="flex flex-wrap items-center gap-1 border-t border-faint pt-2">
                          <button type="button" onClick={() => { void refreshModels(provider); setMoreOpen(null); }} disabled={busy !== null} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 py-1 text-[11px] text-text hover:bg-surface-2 disabled:opacity-40">
                            <RefreshCw size={11} />
                            {t("settings.resources.refreshModels", { defaultValue: "Refresh Models" })}
                          </button>
                          <button type="button" onClick={() => { void setProviderEnabled(provider, !provider.enabled); setMoreOpen(null); }} disabled={busy !== null} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 py-1 text-[11px] text-text hover:bg-surface-2 disabled:opacity-40">
                            {provider.enabled ? t("settings.resources.disableProvider", { defaultValue: "Disable Provider" }) : t("settings.resources.enableProvider", { defaultValue: "Enable Provider" })}
                          </button>
                          <button type="button" onClick={() => setConfirmDelete(provider)} disabled={busy !== null} className="flex min-h-8 items-center gap-1 rounded-input border border-error/30 px-2.5 py-1 text-[11px] text-error-text hover:bg-error/10 disabled:opacity-40">
                            <Trash2 size={11} />
                            {t("common.deleteProvider", { defaultValue: "Delete Provider" })}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" onClick={openCreate} className="flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-input border border-dashed border-faint text-xs text-muted hover:border-accent hover:text-text">
                  <Plus size={14} />
                  {t("settings.resources.addProvider", { defaultValue: "Add Provider" })}
                </button>
              </div>
            </>
          )}

          <details className="overflow-hidden rounded-input border border-faint">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-text marker:content-none">
              <span className="flex-1">{t("settings.resources.connections", { defaultValue: "API connections (Advanced)" })}</span>
              {endpoints.length > 0 && <span className="text-[10px] text-muted">{endpoints.length}</span>}
            </summary>
            <div className="border-t border-faint px-3">
              <p className="py-2 text-[11px] text-muted">{t("settings.resources.connectionsHelp", { defaultValue: "A connection is the API address. Adding a provider creates one automatically; manage enable/disable and priority here." })}</p>
              <div className="divide-y divide-faint">
                {endpoints.length === 0 ? <p className="py-3 text-[11px] text-muted">{t("settings.resources.noConnections", { defaultValue: "No API connections yet." })}</p> : endpoints.map((endpoint) => {
                  const id = endpoint.id || endpoint.endpoint_id || "";
                  const usedBy = bindings.filter((binding) => binding.endpoint_id === id).map((binding) => providers.find((provider) => provider.id === binding.provider_id)?.name).filter(Boolean);
                  return <div key={id} className="flex min-h-11 items-center gap-2 py-2 text-[11px]">
                    <span className="min-w-0 flex-1 truncate text-text">
                      <span className="font-medium">{endpoint.name}</span>
                      <span className="ml-2 font-mono text-muted">{endpoint.base_url}</span>
                      {usedBy.length > 0 && <span className="ml-2 text-muted">{t("settings.resources.usedBy", { defaultValue: "Used by" })}: {usedBy.join(", ")}</span>}
                    </span>
                    <span className={cn(endpoint.health === "ready" ? "text-ok-text" : endpoint.health === "error" || endpoint.health === "blocked" ? "text-error-text" : "text-muted")}>{endpoint.health}</span>
                    <button type="button" aria-label={t("settings.resources.check", { defaultValue: "Check API connection" })} onClick={() => void probeEndpoint(endpoint)} disabled={busy === `probe:${id}`} className="rounded-input p-1.5 text-muted hover:bg-surface-2 hover:text-text"><RefreshCw size={12} className={cn(busy === `probe:${id}` && "animate-spin")} /></button>
                    <button type="button" aria-label={endpoint.enabled ? t("settings.actions.off") : t("settings.actions.on")} onClick={() => void toggleEndpoint(endpoint)} className={cn("rounded-input px-2 py-1", endpoint.enabled ? "bg-ok/10 text-ok-text" : "bg-surface-2 text-muted")}>{endpoint.enabled ? t("settings.actions.on") : t("settings.actions.off")}</button>
                    <button type="button" aria-label={`${t("common.delete")} ${endpoint.name}`} onClick={() => void removeEndpoint(endpoint)} disabled={busy !== null} className="rounded-input p-1.5 text-error-text hover:bg-error/10 disabled:opacity-40"><Trash2 size={12} /></button>
                  </div>;
                })}
              </div>
            </div>
          </details>
      </div>

      {/* Add / Edit provider modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[85vh] w-full max-w-lg space-y-3 overflow-auto rounded-card border border-faint bg-surface-raised p-4">
            <p className="text-sm font-semibold text-text">
              {modal.mode === "edit" ? t("settings.resources.editProviderTitle", { defaultValue: "Edit provider" }) : t("settings.resources.addProvider", { defaultValue: "Add Provider" })}
            </p>
            {modal.mode === "edit" && (
              <div className="flex items-center gap-2 rounded-input bg-surface-2 px-3 py-2 text-[11px]">
                <span className="text-muted">{t("settings.resources.connection", { defaultValue: "Connection" })}</span>
                <span className="text-text">{connectionFor(modal.provider.id)?.base_url ?? "—"}</span>
                <span className={cn("ml-auto flex items-center gap-1", modal.provider.credential_status === "configured" || modal.provider.credential_status === "connected" ? "text-ok-text" : "text-muted")}>
                  {modal.provider.credential_status === "configured" || modal.provider.credential_status === "connected" ? `API key ✓` : t("settings.resources.needsKey", { defaultValue: "needs key" })}
                </span>
              </div>
            )}
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("settings.resources.name", { defaultValue: "Provider name" })} className="min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 text-xs text-text outline-none focus:border-accent" />
            <input value={form.baseUrl} onChange={(event) => { setForm({ ...form, baseUrl: event.target.value }); invalidateTestResult(); }} placeholder={t("settings.resources.baseUrl", { defaultValue: "Base URL, for example https://api.example.com/v1" })} className="min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent" />
            <div className="grid gap-2 sm:grid-cols-2">
              <SettingsSelectMenu
                variant="field"
                ariaLabel={t("settings.resources.protocol", { defaultValue: "Protocol" })}
                value={form.protocol}
                options={[
                  { value: "openai", label: t("settings.resources.openai", { defaultValue: "OpenAI-compatible" }) },
                  { value: "anthropic", label: t("settings.resources.anthropic", { defaultValue: "Anthropic-compatible" }) },
                  { value: "ollama", label: t("settings.resources.ollama", { defaultValue: "Ollama" }) },
                ]}
                onSelect={(value) => { setForm({ ...form, protocol: value as ProviderForm["protocol"] }); invalidateTestResult(); }}
              />
              <SettingsSelectMenu
                variant="field"
                ariaLabel={t("settings.resources.auth", { defaultValue: "Authentication" })}
                value={form.authKind}
                options={[
                  { value: "api_key", label: t("settings.resources.managedKey", { defaultValue: "API key" }) },
                  { value: "none", label: t("settings.resources.noAuth", { defaultValue: "No authentication" }) },
                ]}
                onSelect={(value) => { const authKind = value as ProviderForm["authKind"]; setForm({ ...form, authKind, ...(authKind === "none" ? { apiKey: "" } : {}) }); invalidateTestResult(); }}
              />
            </div>
            {form.authKind === "api_key" && (
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => { setForm({ ...form, apiKey: event.target.value }); invalidateTestResult(); }}
                placeholder={modal.mode === "edit" ? t("settings.resources.editKeyPlaceholder", { defaultValue: "New API key (leave empty to keep)" }) : t("settings.resources.apiKey", { defaultValue: "API key" })}
                className="min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent"
              />
            )}
            <label className="flex items-start gap-2 rounded-input border border-faint px-3 py-2 text-[11px] text-text">
              <input type="checkbox" className="mt-0.5 accent-accent" checked={form.allowPrivate} onChange={(event) => { setForm({ ...form, allowPrivate: event.target.checked }); invalidateTestResult(); }} />
              <span>
                {t("settings.resources.allowPrivate", { defaultValue: "Allow this provider to access localhost and private-network addresses" })}
                <span className="mt-0.5 block text-muted">{t("settings.resources.allowPrivateHelp", { defaultValue: "Enable only for a provider you trust, such as a local Ollama or vLLM server." })}</span>
              </span>
            </label>

            <button
              type="button"
              onClick={() => void runTest()}
              disabled={busy !== null || !form.baseUrl.trim()}
              className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded-input border border-border px-3 py-2 text-xs font-medium text-text hover:bg-surface-2 disabled:opacity-40"
            >
              {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}
              {t("settings.resources.testDiscover", { defaultValue: "Test & Discover" })}
            </button>

            {testResult && (
              <div className="space-y-2 rounded-input border border-faint p-3">
                <p className="flex items-center gap-1.5 text-[11px] text-ok-text">
                  <Check size={12} />
                  {t("settings.resources.connectionSuccessful", { defaultValue: "Connection successful" })} — {t("settings.resources.foundModels", { defaultValue: "Found" })} {testResult.models.length} {t("settings.resources.models", { defaultValue: "models" })}
                </p>
                <div className="flex items-center justify-between text-[11px]">
                  <label className="flex cursor-pointer items-center gap-1.5 text-text">
                    <input type="checkbox" className="accent-accent" checked={selectedModels.size === testResult.models.length && testResult.models.length > 0} onChange={(event) => setSelectedModels(event.target.checked ? new Set(testResult.models.map((model) => model.id)) : new Set())} />
                    {t("settings.resources.selectAll", { defaultValue: "Select all" })}
                  </label>
                  <span className="text-muted">{selectedModels.size}/{testResult.models.length}</span>
                </div>
                <div className="max-h-40 space-y-1 overflow-auto">
                  {testResult.models.map((model) => (
                    <label key={model.id} className="flex cursor-pointer items-center gap-1.5 rounded-input px-2 py-1 text-[11px] text-text hover:bg-surface-2">
                      <input type="checkbox" className="accent-accent" checked={selectedModels.has(model.id)} onChange={() => toggleModel(model.id)} />
                      <span className="truncate font-mono">{model.id}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {modal.mode === "edit" && editingModels.length > 0 && !testResult && (
              <div className="space-y-2 rounded-input border border-faint p-3">
                <p className="text-[11px] font-medium text-text">{t("settings.resources.manageModels", { defaultValue: "Models" })}</p>
                <div className="flex items-center justify-between text-[11px]">
                  <label className="flex cursor-pointer items-center gap-1.5 text-text">
                    <input type="checkbox" className="accent-accent" checked={editingModels.every((model) => selectedModels.has(model.model_id))} onChange={(event) => setSelectedModels(event.target.checked ? new Set(editingModels.map((model) => model.model_id)) : new Set())} disabled={editingModels.length === 0} />
                    {t("settings.resources.selectAll", { defaultValue: "Select all" })}
                  </label>
                  <span className="text-muted">{selectedModels.size}/{editingModels.length}</span>
                </div>
                <div className="max-h-40 space-y-1 overflow-auto">
                  {editingModels.map((model) => (
                    <label key={model.model_id} className="flex cursor-pointer items-center gap-1.5 rounded-input px-2 py-1 text-[11px] text-text hover:bg-surface-2">
                      <input type="checkbox" className="accent-accent" checked={selectedModels.has(model.model_id)} onChange={() => toggleModel(model.model_id)} />
                      <span className="truncate font-mono">{model.model_id}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setModal(null)} disabled={busy !== null} className="min-h-9 rounded-input px-3 py-2 text-xs text-muted hover:text-text">{t("common.cancel", { defaultValue: "Cancel" })}</button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy !== null || !form.name.trim() || !form.baseUrl.trim()}
                className="flex min-h-9 items-center justify-center gap-1.5 rounded-input bg-accent-fill px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40"
              >
                {busy === "save" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {modal.mode === "edit" ? t("common.save", { defaultValue: "Save" }) : t("settings.resources.addProvider", { defaultValue: "Add Provider" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="alertdialog" aria-modal="true">
          <div className="w-full max-w-sm space-y-3 rounded-card border border-faint bg-surface-raised p-4">
            <p className="text-sm font-semibold text-text">{t("settings.resources.deleteTitle", { defaultValue: "Delete" })} "{confirmDelete.name}"?</p>
            <p className="text-[11px] leading-relaxed text-muted">
              {t("settings.resources.deleteBody", { defaultValue: "This will remove its models, its binding, its private API connection, and its managed API credential. Shared connections or credentials will not be removed." })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(null)} disabled={busy !== null} className="min-h-9 rounded-input px-3 py-2 text-xs text-muted hover:text-text">{t("common.cancel", { defaultValue: "Cancel" })}</button>
              <button type="button" onClick={() => void removeProvider(confirmDelete)} disabled={busy !== null} className="flex min-h-9 items-center gap-1.5 rounded-input bg-error/10 px-3 py-2 text-xs font-medium text-error-text hover:bg-error/20 disabled:opacity-40">
                {busy === `delete:${confirmDelete.id}` ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {t("common.deleteProvider", { defaultValue: "Delete Provider" })}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
