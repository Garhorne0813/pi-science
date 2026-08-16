import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { modelEndpointsQuery, settingsApi } from "../../lib/settings";
import type { ModelEndpoint } from "../../lib/settings";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

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
    <details className="group overflow-hidden rounded-card border border-faint bg-surface-2/40">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-2 marker:content-none">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-text">{t("settings.endpoints.title")}</h2>
        </div>
        {endpoints.length > 0 && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted">{endpoints.length}</span>}
        <ChevronDown size={14} className="shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-faint px-4 py-3">
        {error && <p className="mb-3 rounded-input bg-error/10 px-3 py-2 text-xs text-error-text">{error}</p>}
        <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("settings.endpoints.name")} className="min-h-10 rounded-input border border-border bg-bg px-3 py-2 text-xs text-text outline-none focus:border-accent" />
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://host/v1" className="min-h-10 rounded-input border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent" />
          <button type="button" onClick={() => void add()} className="min-h-10 rounded-input bg-accent-fill px-3 py-2 text-xs font-medium text-accent-fg disabled:opacity-40" disabled={!name.trim() || !baseUrl.trim()}>
            {t("settings.endpoints.register")}
          </button>
        </div>
        <SettingsSelectMenu
          variant="field"
          ariaLabel={t("settings.endpoints.protocolLabel")}
          value={protocol}
          options={[
            { value: "openai", label: t("settings.endpoints.protocol.openai") },
            { value: "anthropic", label: t("settings.endpoints.protocol.anthropic") },
            { value: "native", label: t("settings.endpoints.protocol.native") },
          ]}
          className="mt-2 h-9 w-auto min-w-[11rem] bg-bg"
          onSelect={(next) => setProtocol(next)}
        />
        <div className="mt-3 divide-y divide-faint empty:hidden">
          {endpoints.map((endpoint) => (
            <div key={endpoint.endpoint_id} className="flex min-h-11 items-center gap-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-text">
                {endpoint.name}
                <span className="ml-2 font-mono text-[11px] text-muted">{endpoint.base_url}</span>
              </span>
              <span className={cn("text-[11px]", endpoint.health === "ready" ? "text-ok-text" : endpoint.health === "error" ? "text-error-text" : "text-muted")}>{endpoint.health}</span>
              <button type="button" onClick={() => void settingsApi.checkEndpointHealth(endpoint.endpoint_id)} className="rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2">{t("settings.endpoints.check")}</button>
              <button type="button" onClick={() => void settingsApi.setEndpointEnabled(endpoint.endpoint_id, !endpoint.enabled)} className={cn("rounded-input px-2 py-1 text-xs", endpoint.enabled ? "bg-ok/10 text-ok-text" : "bg-surface-2 text-muted")}>{endpoint.enabled ? t("settings.actions.on") : t("settings.actions.off")}</button>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}
