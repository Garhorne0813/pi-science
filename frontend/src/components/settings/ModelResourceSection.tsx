import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, RefreshCw, Server, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { queryClient } from "../../lib/client/query-client";
import { modelResourceKeys, modelResourcesApi } from "../../lib/model-resources";
import type { ModelEndpointResource, ModelProvider } from "../../lib/model-resources";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

export function ModelResourceSection({ onConfigReload }: { onConfigReload: () => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState<"openai" | "anthropic" | "ollama">("openai");
  const [authKind, setAuthKind] = useState<"api_key" | "none">("api_key");
  const [apiKey, setApiKey] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providersRead = useQuery({ queryKey: modelResourceKeys.providers, queryFn: modelResourcesApi.providers, staleTime: 0 });
  const endpointsRead = useQuery({ queryKey: modelResourceKeys.endpoints, queryFn: modelResourcesApi.endpoints, staleTime: 0 });
  const providers = (providersRead.data?.providers ?? []).filter((provider) => provider.kind === "user");
  const endpoints = endpointsRead.data?.endpoints ?? [];

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: modelResourceKeys.providers }),
      queryClient.invalidateQueries({ queryKey: modelResourceKeys.endpoints }),
      queryClient.invalidateQueries({ queryKey: ["model-resources", "models"] }),
      queryClient.invalidateQueries({ queryKey: ["model-resources", "bindings"] }),
    ]);
  };

  const reset = () => {
    setName("");
    setBaseUrl("");
    setProtocol("openai");
    setAuthKind("api_key");
    setApiKey("");
    setOpen(false);
  };

  const addProvider = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    if (authKind === "api_key" && !apiKey.trim()) {
      setError(t("settings.resources.keyRequired", { defaultValue: "Enter an API key or choose No authentication." }));
      return;
    }
    setBusy("add");
    setError(null);
    try {
      const credential = authKind === "api_key"
        ? (await modelResourcesApi.createCredential({ kind: "api_key", backend: "managed", secret: apiKey.trim(), label: `${name.trim()} key` })).credential
        : null;
      const endpoint = (await modelResourcesApi.createEndpoint({ name: `${name.trim()} ${t("settings.resources.connectionSuffix", { defaultValue: "connection" })}`, base_url: baseUrl.trim(), protocol, credential_ref: credential?.id ?? null, data_egress: baseUrl.startsWith("http://127.") || baseUrl.includes("localhost") ? "local" : "remote" })).endpoint;
      const provider = (await modelResourcesApi.createProvider({ name: name.trim(), adapter: protocol === "anthropic" ? "anthropic-compatible" : protocol === "ollama" ? "ollama" : "openai-compatible", catalog_mode: "hybrid", auth_kind: authKind, enabled: true })).provider;
      const binding = (await modelResourcesApi.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, priority: 100, enabled: true })).binding;
      try {
        await modelResourcesApi.discover(provider.id, binding.id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      await invalidate();
      await onConfigReload();
      reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleEndpoint = async (endpoint: ModelEndpointResource) => {
    setBusy(endpoint.id || endpoint.endpoint_id || "endpoint");
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

  const removeProvider = async (provider: ModelProvider) => {
    setBusy(`delete:${provider.id}`);
    setError(null);
    try {
      await modelResourcesApi.deleteProvider(provider.id);
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
    setBusy(`delete:${id}`);
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
    setBusy(`probe:${endpoint.id || endpoint.endpoint_id}`);
    setError(null);
    try {
      await modelResourcesApi.probeEndpoint(endpoint.id || endpoint.endpoint_id || "");
      await invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-card border border-faint bg-surface-2/40">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-text">{t("settings.resources.title", { defaultValue: "Providers and connections" })}</h2>
          <p className="mt-0.5 text-[11px] text-muted">{t("settings.resources.description", { defaultValue: "Add a provider, store its credential safely, and discover its models." })}</p>
        </div>
        {(providers.length > 0 || endpoints.length > 0) && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted">{providers.length + endpoints.length}</span>}
        <ChevronDown size={14} className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-faint px-4 py-3">
          {error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-[11px] text-error-text">{error}</p>}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-text">{t("settings.resources.addTitle", { defaultValue: "Add provider" })}</p>
              <span className="text-[10px] text-muted">{t("settings.resources.zeroEnv", { defaultValue: "Managed credentials need no shell environment variables." })}</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("settings.resources.name", { defaultValue: "Provider name" })} className="min-h-10 rounded-input border border-border bg-bg px-3 py-2 text-xs text-text outline-none focus:border-accent" />
              <SettingsSelectMenu
                variant="field"
                ariaLabel={t("settings.resources.protocol", { defaultValue: "Protocol" })}
                value={protocol}
                options={[
                  { value: "openai", label: t("settings.resources.openai", { defaultValue: "OpenAI-compatible" }) },
                  { value: "anthropic", label: t("settings.resources.anthropic", { defaultValue: "Anthropic-compatible" }) },
                  { value: "ollama", label: t("settings.resources.ollama", { defaultValue: "Ollama" }) },
                ]}
                onSelect={(value) => setProtocol(value as typeof protocol)}
              />
            </div>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={t("settings.resources.baseUrl", { defaultValue: "Base URL, for example https://api.example.com/v1" })} className="min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent" />
            <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
              <SettingsSelectMenu
                variant="field"
                ariaLabel={t("settings.resources.auth", { defaultValue: "Authentication" })}
                value={authKind}
                options={[
                  { value: "api_key", label: t("settings.resources.managedKey", { defaultValue: "Managed API key" }) },
                  { value: "none", label: t("settings.resources.noAuth", { defaultValue: "No authentication" }) },
                ]}
                onSelect={(value) => setAuthKind(value as typeof authKind)}
              />
              {authKind === "api_key" && <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t("settings.resources.apiKey", { defaultValue: "API key" })} className="min-h-10 rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent" />}
              <button type="button" onClick={() => void addProvider()} disabled={busy !== null || !name.trim() || !baseUrl.trim()} className="flex min-h-10 items-center justify-center gap-1.5 rounded-input bg-accent-fill px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40">
                {busy === "add" ? <Loader2 size={12} className="animate-spin" /> : <Server size={12} />}
                {t("settings.resources.add", { defaultValue: "Add provider" })}
              </button>
            </div>
          </div>

          {providers.length > 0 && (
            <div className="divide-y divide-faint overflow-hidden rounded-input border border-faint">
              <p className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{t("settings.resources.providers", { defaultValue: "Providers" })}</p>
              {providers.map((provider: ModelProvider) => (
                <div key={provider.id} className="flex min-h-12 items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-text">{provider.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted">{provider.id} · {provider.models.length} {t("settings.resources.models", { defaultValue: "models" })}</p>
                  </div>
                  <span className={cn("flex items-center gap-1 text-[10px]", provider.credential_status === "configured" || provider.credential_status === "connected" ? "text-ok-text" : "text-muted")}>
                    {(provider.credential_status === "configured" || provider.credential_status === "connected") && <Check size={10} />}
                    {provider.credential_status}
                  </span>
                  <button type="button" aria-label={`${t("common.delete")} ${provider.name}`} onClick={() => void removeProvider(provider)} disabled={busy !== null} className="rounded-input p-1.5 text-error-text hover:bg-error/10 disabled:opacity-40"><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          )}

          <details className="overflow-hidden rounded-input border border-faint">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-text marker:content-none">
              <span className="flex-1">{t("settings.resources.connections", { defaultValue: "Connections (Advanced)" })}</span>
              {endpoints.length > 0 && <span className="text-[10px] text-muted">{endpoints.length}</span>}
            </summary>
            <div className="divide-y divide-faint border-t border-faint px-3">
              {endpoints.length === 0 ? <p className="py-3 text-[11px] text-muted">{t("settings.resources.noConnections", { defaultValue: "No connections yet." })}</p> : endpoints.map((endpoint) => {
                const id = endpoint.id || endpoint.endpoint_id || "";
                return <div key={id} className="flex min-h-11 items-center gap-2 py-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-text"><span className="font-medium">{endpoint.name}</span><span className="ml-2 font-mono text-muted">{endpoint.base_url}</span></span>
                  <span className={cn(endpoint.health === "ready" ? "text-ok-text" : endpoint.health === "error" || endpoint.health === "blocked" ? "text-error-text" : "text-muted")}>{endpoint.health}</span>
                  <button type="button" aria-label={t("settings.resources.check", { defaultValue: "Check connection" })} onClick={() => void probeEndpoint(endpoint)} disabled={busy === `probe:${id}`} className="rounded-input p-1.5 text-muted hover:bg-surface-2 hover:text-text"><RefreshCw size={12} className={cn(busy === `probe:${id}` && "animate-spin")} /></button>
                  <button type="button" aria-label={endpoint.enabled ? t("settings.actions.off") : t("settings.actions.on")} onClick={() => void toggleEndpoint(endpoint)} className={cn("rounded-input px-2 py-1", endpoint.enabled ? "bg-ok/10 text-ok-text" : "bg-surface-2 text-muted")}>{endpoint.enabled ? t("settings.actions.on") : t("settings.actions.off")}</button>
                  <button type="button" aria-label={`${t("common.delete")} ${endpoint.name}`} onClick={() => void removeEndpoint(endpoint)} disabled={busy !== null} className="rounded-input p-1.5 text-error-text hover:bg-error/10 disabled:opacity-40"><Trash2 size={12} /></button>
                </div>;
              })}
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
