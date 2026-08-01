import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { modelEndpointsQuery, settingsApi } from "../../lib/settings";
import type { ModelEndpoint } from "../../lib/settings";

export function ModelEndpointSection() {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState("openai");
  const [formError, setFormError] = useState<string | null>(null);

  const endpointsRead = useQuery(modelEndpointsQuery(t("settings.endpoints.loadError")));
  const endpoints: ModelEndpoint[] = endpointsRead.data?.endpoints || [];
  const error = formError ?? (endpointsRead.error instanceof Error ? endpointsRead.error.message : null);

  const add = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    setFormError(null);
    try {
      await settingsApi.registerEndpoint({ name: name.trim(), base_url: baseUrl.trim(), protocol, data_egress: "remote" }, t("settings.endpoints.registerError"));
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setName("");
    setBaseUrl("");
  };

  return (
    <details className="group overflow-hidden rounded-card border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 marker:content-none">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text">{t("settings.endpoints.title")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t("settings.endpoints.description")}</p>
        </div>
        {endpoints.length > 0 && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{endpoints.length}</span>}
        <ChevronDown size={15} className="shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-faint px-5 py-4">
        {error && <p className="mb-3 rounded-input bg-error/10 px-3 py-2 text-xs text-error">{error}</p>}
        <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("settings.endpoints.name")} className="min-h-10 rounded-input border border-border bg-bg px-3 py-2 text-xs text-text outline-none focus:border-accent" />
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://host/v1" className="min-h-10 rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent" />
          <button type="button" onClick={() => void add()} className="min-h-10 rounded-input bg-accent px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40" disabled={!name.trim() || !baseUrl.trim()}>
            {t("settings.endpoints.register")}
          </button>
        </div>
        <select value={protocol} onChange={(event) => setProtocol(event.target.value)} className="mt-2 min-h-10 rounded-input border border-border bg-bg px-3 py-2 text-xs text-text outline-none focus:border-accent">
          <option value="openai">{t("settings.endpoints.protocol.openai")}</option>
          <option value="anthropic">{t("settings.endpoints.protocol.anthropic")}</option>
          <option value="native">{t("settings.endpoints.protocol.native")}</option>
        </select>
        <div className="mt-4 divide-y divide-faint rounded-input border border-border empty:hidden">
          {endpoints.map((endpoint) => (
            <div key={endpoint.endpoint_id} className="flex min-h-11 items-center gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-text">
                {endpoint.name}
                <span className="ml-2 font-mono text-[11px] text-muted">{endpoint.base_url}</span>
              </span>
              <span className={cn("text-[11px]", endpoint.health === "ready" ? "text-ok" : endpoint.health === "error" ? "text-error" : "text-muted")}>{endpoint.health}</span>
              <button type="button" onClick={() => void settingsApi.checkEndpointHealth(endpoint.endpoint_id)} className="rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2">{t("settings.endpoints.check")}</button>
              <button type="button" onClick={() => void settingsApi.setEndpointEnabled(endpoint.endpoint_id, !endpoint.enabled)} className={cn("rounded-input px-2 py-1 text-xs", endpoint.enabled ? "bg-ok/10 text-ok" : "bg-surface-2 text-muted")}>{endpoint.enabled ? t("settings.actions.on") : t("settings.actions.off")}</button>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}
