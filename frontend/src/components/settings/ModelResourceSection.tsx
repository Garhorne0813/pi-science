import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, Pencil, PlugZap, RefreshCw, Server, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { queryClient } from "../../lib/client/query-client";
import { modelResourceKeys, modelResourcesApi } from "../../lib/model-resources";
import type { ModelEndpointResource, ModelProvider } from "../../lib/model-resources";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

type ProviderForm = {
  name: string;
  baseUrl: string;
  protocol: "openai" | "anthropic" | "ollama";
  authKind: "api_key" | "none";
  apiKey: string;
};

const EMPTY_FORM: ProviderForm = { name: "", baseUrl: "", protocol: "openai", authKind: "api_key", apiKey: "" };

/** Custom provider as a single card: Name / Base URL / Auth / key, plus
 *  connection status and test. The canonical Provider/Endpoint/Binding split
 *  stays inside the advanced connections section. */
export function ModelResourceSection({ onConfigReload }: { onConfigReload: () => Promise<void> }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providersRead = useQuery({ queryKey: modelResourceKeys.providers, queryFn: modelResourcesApi.providers, staleTime: 0 });
  const endpointsRead = useQuery({ queryKey: modelResourceKeys.endpoints, queryFn: modelResourcesApi.endpoints, staleTime: 0 });
  const bindingsRead = useQuery({ queryKey: modelResourceKeys.bindings(), queryFn: () => modelResourcesApi.bindings(), staleTime: 0 });
  const providers = (providersRead.data?.providers ?? []).filter((provider) => provider.kind === "user");
  const endpoints = endpointsRead.data?.endpoints ?? [];
  const bindings = bindingsRead.data?.bindings ?? [];

  const connectionFor = (providerId: string): ModelEndpointResource | undefined => {
    const binding = bindings.find((item) => item.provider_id === providerId);
    return binding ? endpoints.find((item) => item.id === binding.endpoint_id) : undefined;
  };

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: modelResourceKeys.providers }),
      queryClient.invalidateQueries({ queryKey: modelResourceKeys.endpoints }),
      queryClient.invalidateQueries({ queryKey: ["model-resources", "models"] }),
      queryClient.invalidateQueries({ queryKey: ["model-resources", "bindings"] }),
    ]);
  };

  const editing = editingId ? providers.find((provider) => provider.id === editingId) : null;
  const editingConnection = editing ? connectionFor(editing.id) : undefined;

  const saveForm = async () => {
    if (!form.name.trim() || !form.baseUrl.trim()) return;
    if (form.authKind === "api_key" && !form.apiKey.trim() && !editing) {
      setError(t("settings.resources.keyRequired", { defaultValue: "Enter an API key or choose No authentication." }));
      return;
    }
    setBusy("save");
    setError(null);
    try {
      if (!editing) {
        const result = await modelResourcesApi.createCustomProvider({
          name: form.name.trim(),
          base_url: form.baseUrl.trim(),
          protocol: form.protocol,
          auth: form.authKind === "api_key" ? { kind: "api_key", secret: form.apiKey.trim() } : { kind: "none" },
        });
        if (result.discovery_error) setError(result.discovery_error);
      } else {
        await modelResourcesApi.updateCustomProvider(editing.id, {
          name: form.name.trim(),
          base_url: form.baseUrl.trim(),
          ...(form.apiKey.trim() ? { auth: { kind: "api_key" as const, secret: form.apiKey.trim() } } : {}),
        });
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      await invalidate();
      await onConfigReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const beginEdit = (provider: ModelProvider) => {
    const connection = connectionFor(provider.id);
    const protocol = provider.adapter === "anthropic-compatible" ? "anthropic" : provider.adapter === "ollama" ? "ollama" : "openai";
    setForm({ name: provider.name, baseUrl: connection?.base_url ?? "", protocol, authKind: "api_key", apiKey: "" });
    setEditingId(provider.id);
  };

  const deleteEditing = async () => {
    const target = editing;
    if (!target) return;
    setBusy(`delete:${target.id}`);
    setError(null);
    try {
      await removeProvider(target);
    } finally {
      setBusy(null);
    }
  };

  const removeProvider = async (provider: ModelProvider) => {
    setError(null);
    await modelResourcesApi.deleteCustomProvider(provider.id);
    if (editingId === provider.id) {
      setForm(EMPTY_FORM);
      setEditingId(null);
    }
    await invalidate();
    await onConfigReload();
  };

  const testEditing = async () => {
    if (!editingConnection) return;
    setBusy("test");
    setError(null);
    try {
      await modelResourcesApi.probeEndpoint(editingConnection.id || editingConnection.endpoint_id || "");
      await invalidate();
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const statusText = editing
    ? editing.credential_status === "connected" ? t("settings.resources.connected", { defaultValue: "Connected" })
      : editing.credential_status === "configured" ? t("settings.resources.configured", { defaultValue: "Configured" })
      : editing.credential_status
    : "";

  return (
    <section className="overflow-hidden rounded-card border border-faint bg-surface-2/40">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-text">{t("settings.resources.title", { defaultValue: "Providers and API connections" })}</h2>
          <p className="mt-0.5 text-[11px] text-muted">{t("settings.resources.description", { defaultValue: "A provider is the model service; a connection is its API address. Adding a provider creates a connection and discovers models." })}</p>
        </div>
        {(providers.length > 0 || endpoints.length > 0) && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted">{providers.length + endpoints.length}</span>}
        <ChevronDown size={14} className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-faint px-4 py-3">
          {error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-[11px] text-error-text">{error}</p>}

          {/* Custom provider card: the one normal way to add or edit a provider. */}
          <div className="space-y-2 rounded-input border border-faint p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-text">{editing ? t("settings.resources.editProviderTitle", { defaultValue: "Edit provider" }) : t("settings.resources.addTitle", { defaultValue: "Add provider" })}</p>
              <span className="text-[10px] text-muted">{t("settings.resources.zeroEnv", { defaultValue: "Keys stored by Pi-Science need no environment variable." })}</span>
            </div>
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder={t("settings.resources.name", { defaultValue: "Provider name" })}
              className="min-h-10 rounded-input border border-border bg-bg px-3 py-2 text-xs text-text outline-none focus:border-accent"
            />
            <input
              value={form.baseUrl}
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              placeholder={t("settings.resources.baseUrl", { defaultValue: "Base URL, for example https://api.example.com/v1" })}
              className="min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent"
            />
            <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr]">
              <SettingsSelectMenu
                variant="field"
                ariaLabel={t("settings.resources.protocol", { defaultValue: "Protocol" })}
                value={form.protocol}
                options={[
                  { value: "openai", label: t("settings.resources.openai", { defaultValue: "OpenAI-compatible" }) },
                  { value: "anthropic", label: t("settings.resources.anthropic", { defaultValue: "Anthropic-compatible" }) },
                  { value: "ollama", label: t("settings.resources.ollama", { defaultValue: "Ollama" }) },
                ]}
                onSelect={(value) => setForm({ ...form, protocol: value as ProviderForm["protocol"] })}
              />
              <SettingsSelectMenu
                variant="field"
                ariaLabel={t("settings.resources.auth", { defaultValue: "Authentication" })}
                value={form.authKind}
                options={[
                  { value: "api_key", label: t("settings.resources.managedKey", { defaultValue: "API key stored by Pi-Science" }) },
                  { value: "none", label: t("settings.resources.noAuth", { defaultValue: "No authentication" }) },
                ]}
                onSelect={(value) => setForm({ ...form, authKind: value as ProviderForm["authKind"] })}
              />
            </div>
            {form.authKind === "api_key" && (
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                placeholder={editing ? t("settings.resources.editKeyPlaceholder", { defaultValue: "New API key (leave empty to keep)" }) : t("settings.resources.apiKey", { defaultValue: "API key" })}
                className="min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent"
              />
            )}
            {editing && (
              <div className="flex flex-wrap items-center gap-3 rounded-input bg-surface-2 px-3 py-2">
                <span className="flex items-center gap-1.5 text-[11px]">
                  <span className={cn("size-1.5 rounded-full", editing.credential_status === "configured" || editing.credential_status === "connected" ? "bg-ok" : "bg-muted")} />
                  <span className="text-text">{t("settings.resources.connection", { defaultValue: "Connection" })}</span>
                  <span className={cn(editing.credential_status === "configured" || editing.credential_status === "connected" ? "text-ok-text" : "text-muted")}>{statusText}</span>
                </span>
                <span className="text-[11px] text-muted">{t("settings.resources.models", { defaultValue: "models" })}: {editing.models.length} {t("settings.resources.discovered", { defaultValue: "discovered" })}</span>
                <button type="button" onClick={() => void testEditing()} disabled={busy !== null || !editingConnection} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 py-1 text-[11px] text-text hover:bg-surface-2 disabled:opacity-40">
                  {busy === "test" ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {t("settings.resources.test", { defaultValue: "Test" })}
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void saveForm()}
                disabled={busy !== null || !form.name.trim() || !form.baseUrl.trim()}
                className="flex min-h-9 items-center justify-center gap-1.5 rounded-input bg-accent-fill px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40"
              >
                {busy === "save" ? <Loader2 size={12} className="animate-spin" /> : editing ? <Check size={12} /> : <Server size={12} />}
                {editing ? t("common.save", { defaultValue: "Save" }) : t("settings.resources.add", { defaultValue: "Add provider" })}
              </button>
              {editing && (
                <>
                  <button type="button" onClick={() => void deleteEditing()} disabled={busy !== null} className="flex min-h-9 items-center gap-1.5 rounded-input px-3 py-2 text-xs font-medium text-error-text hover:bg-error/10 disabled:opacity-40">
                    <Trash2 size={12} />
                    {t("common.deleteProvider", { defaultValue: "Delete Provider" })}
                  </button>
                  <button type="button" onClick={() => { setForm(EMPTY_FORM); setEditingId(null); }} disabled={busy !== null} className="min-h-9 rounded-input px-3 py-2 text-xs text-muted hover:text-text">
                    {t("common.cancel", { defaultValue: "Cancel" })}
                  </button>
                </>
              )}
            </div>
          </div>

          {providers.length > 0 && (
            <div className="divide-y divide-faint overflow-hidden rounded-input border border-faint">
              <p className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{t("settings.resources.providers", { defaultValue: "Providers" })}</p>
              {providers.map((provider: ModelProvider) => {
                const connection = connectionFor(provider.id);
                return (
                  <div key={provider.id} className="flex min-h-11 items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-text">{provider.name}</p>
                      <p className="truncate font-mono text-[10px] text-muted">{connection?.base_url ?? provider.id} · {provider.models.length} {t("settings.resources.models", { defaultValue: "models" })}</p>
                    </div>
                    <span className={cn("flex items-center gap-1 text-[10px]", provider.credential_status === "configured" || provider.credential_status === "connected" ? "text-ok-text" : "text-muted")}>
                      {(provider.credential_status === "configured" || provider.credential_status === "connected") && <Check size={10} />}
                      {provider.credential_status}
                    </span>
                    <button
                      type="button"
                      aria-label={`${t("common.edit")} ${provider.name}`}
                      onClick={() => beginEdit(provider)}
                      disabled={busy !== null}
                      className={cn("rounded-input p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40", editingId === provider.id && "bg-surface-2 text-text")}
                    >
                      <Pencil size={12} />
                    </button>
                    <button type="button" aria-label={`${t("common.delete")} ${provider.name}`} onClick={() => void removeProvider(provider).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))} disabled={busy !== null} className="rounded-input p-1.5 text-error-text hover:bg-error/10 disabled:opacity-40"><Trash2 size={12} /></button>
                  </div>
                );
              })}
            </div>
          )}

          <details className="overflow-hidden rounded-input border border-faint">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-text marker:content-none">
              <span className="flex-1">{t("settings.resources.connections", { defaultValue: "API connections (Advanced)" })}</span>
              {endpoints.length > 0 && <span className="text-[10px] text-muted">{endpoints.length}</span>}
            </summary>
            <div className="border-t border-faint px-3">
              <p className="py-2 text-[11px] text-muted">{t("settings.resources.connectionsHelp", { defaultValue: "A connection is the API address. Adding a provider creates one automatically; check or disable it here." })}</p>
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
      )}
    </section>
  );
}