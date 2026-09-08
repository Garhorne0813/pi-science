import { useEffect, useState } from "react";
import { Edit3, KeyRound, Loader2, PlugZap, RefreshCw, Shield, Trash2 } from "lucide-react";
import type { McpConnector, McpCredentialStatus, McpToolSummary } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import { settingsApi } from "../../lib/settings";

type Backend = "managed" | "environment";
type Delivery = "environment" | "header" | "bearer";

export function McpConnectorDetails({ connector, tools, toolsCachedAt, workspaceCwd, onRefresh, onProbe, onEdit, onDelete, onCredentialChanged, onSetDecision }: {
  connector: McpConnector;
  tools: McpToolSummary[];
  toolsCachedAt: number | null;
  workspaceCwd: string | null;
  onRefresh: () => void;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCredentialChanged: () => Promise<void> | void;
  onSetDecision: (tool: McpToolSummary, decision: "inherit" | "allow" | "ask" | "deny") => void;
}) {
  const { t } = useTranslation();
  const [credential, setCredential] = useState<McpCredentialStatus | null>(null);
  const [backend, setBackend] = useState<Backend>("managed");
  const [delivery, setDelivery] = useState<Delivery>(connector.transport === "stdio" ? "environment" : "bearer");
  const [targetName, setTargetName] = useState(connector.transport === "stdio" ? "API_KEY" : "Authorization");
  const [environmentVariable, setEnvironmentVariable] = useState(connector.transport === "stdio" ? "API_KEY" : "MCP_API_KEY");
  const [secret, setSecret] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const location = connector.endpoint_url || [connector.command, ...connector.args].filter(Boolean).join(" ") || connector.socket_path;

  useEffect(() => {
    let current = true;
    setCredential(null); setCredentialError(null); setSecret("");
    settingsApi.mcpCredential(connector.connector_id).then((status) => {
      if (!current) return;
      const defaultDelivery = connector.transport === "stdio" || connector.transport === "socket" ? "environment" : "bearer";
      const defaultTarget = defaultDelivery === "environment" ? "API_KEY" : "Authorization";
      const nextDelivery = status.delivery ?? status.suggested_delivery ?? defaultDelivery;
      setCredential(status); setBackend(status.backend ?? "managed"); setDelivery(nextDelivery);
      setTargetName(status.target_name ?? status.suggested_target_name ?? defaultTarget);
      setEnvironmentVariable(status.environment_variable ?? status.suggested_target_name ?? "API_KEY");
    }).catch((error) => { if (current) setCredentialError(message(error)); });
    return () => { current = false; };
  }, [connector.connector_id, connector.transport]);

  const changeDelivery = (next: Delivery) => {
    setDelivery(next);
    if (next === "bearer") setTargetName("Authorization");
    else if (next === "environment" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(targetName)) setTargetName(credential?.suggested_target_name ?? "API_KEY");
    else if (next === "header" && targetName === "Authorization") setTargetName("X-API-Key");
  };
  const saveCredential = async () => {
    setCredentialBusy(true); setCredentialError(null);
    try {
      const status = await settingsApi.setMcpCredential(connector.connector_id, {
        backend, delivery, target_name: delivery === "bearer" ? "Authorization" : targetName,
        ...(backend === "managed" && secret ? { secret } : {}),
        ...(backend === "environment" ? { environment_variable: environmentVariable } : {}),
        revision: connector.revision,
      });
      setCredential(status); setSecret(""); await onCredentialChanged();
    } catch (error) { setCredentialError(message(error)); }
    finally { setCredentialBusy(false); }
  };
  const removeCredential = async () => {
    setCredentialBusy(true); setCredentialError(null);
    try { const status = await settingsApi.deleteMcpCredential(connector.connector_id); setCredential(status); setSecret(""); await onCredentialChanged(); }
    catch (error) { setCredentialError(message(error)); }
    finally { setCredentialBusy(false); }
  };

  return <tr id={`mcp-connector-details-${connector.connector_id}`}>
    <td colSpan={4} className="bg-surface-2/20 px-3 pb-3 pt-0">
      <div className="rounded-input border border-border bg-surface px-4 py-3 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><h3 className="font-semibold text-text">{connector.display_name}</h3>{connector.source === "builtin" ? <p className="mt-1 text-xs text-muted">{t("settings.mcpPage.builtinHint")}</p> : <p className="mt-1 truncate font-mono text-xs text-muted" title={location || undefined}>{location}</p>}</div>
          <div className="flex shrink-0 items-center gap-3"><button type="button" onClick={onProbe} className="inline-flex items-center gap-1 text-xs text-link"><PlugZap size={14} />{t("settings.mcpPage.reconnect")}</button>{connector.source !== "builtin" && <><button type="button" onClick={onEdit} className="inline-flex items-center gap-1 text-xs text-link"><Edit3 size={14} />{t("settings.mcpPage.edit")}</button><button type="button" aria-label={t("settings.mcpPage.delete", { name: connector.display_name })} onClick={onDelete} className="text-error-text"><Trash2 size={16} /></button></>}</div>
        </div>

        <section className="mt-4 grid gap-3 rounded-input border border-border bg-surface-2/30 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Info label={t("settings.mcpPage.source")} value={t(`settings.mcpPage.source.${connector.source}`)} />
          <Info label={t("settings.mcpPage.fieldTransport")} value={t(`settings.mcpPage.transport.${connector.transport}`)} />
          <Info label={t("settings.mcpPage.connection")} value={t(`settings.mcpPage.runtimeState.${connector.runtime_state}`)} />
          <Info label={t("settings.mcpPage.auth")} value={t(`settings.mcpPage.authState.${connector.auth_state}`)} />
        </section>

        <section className="mt-4 rounded-input border border-border bg-surface-2/30 p-3">
          <div className="flex items-start justify-between gap-3"><div><h4 className="flex items-center gap-1.5 text-xs font-semibold text-text"><KeyRound size={13} />{t("settings.mcpPage.credentials")}</h4><p className="mt-1 text-[10px] text-muted">{t(credential?.capability === "unsupported" ? "settings.mcpPage.credentialUnsupported" : "settings.mcpPage.credentialsHint")}</p></div>{credential && <span className={`text-[10px] ${credential.configured && credential.capability !== "unsupported" ? "text-ok-text" : "text-muted"}`}>{t(credential.capability === "unsupported" ? credential.credential_ref ? "settings.mcpPage.credentialUnused" : "settings.mcpPage.credentialNotSupported" : credential.configured ? "settings.mcpPage.credentialConfigured" : credential.capability === "required" ? "settings.mcpPage.credentialRequired" : "settings.mcpPage.credentialOptional")}</span>}</div>
          {credential?.capability === "unsupported" ? credential.credential_ref && <div className="mt-3 flex justify-end"><button type="button" disabled={credentialBusy} onClick={() => void removeCredential()} className="px-3 py-2 text-xs text-error-text disabled:text-muted">{t("settings.mcpPage.removeUnusedCredential")}</button></div> : credential ? <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-xs text-muted">{t("settings.mcpPage.credentialBackend")}<select value={backend} onChange={(event) => setBackend(event.target.value as Backend)} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text"><option value="managed">{t("settings.mcpPage.backendManaged")}</option><option value="environment">{t("settings.mcpPage.backendEnvironment")}</option></select></label>
            <label className="text-xs text-muted">{t("settings.mcpPage.credentialDelivery")}<select value={delivery} onChange={(event) => changeDelivery(event.target.value as Delivery)} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text"><option value="environment">{t("settings.mcpPage.deliveryEnvironment")}</option><option value="header">{t("settings.mcpPage.deliveryHeader")}</option><option value="bearer">{t("settings.mcpPage.deliveryBearer")}</option></select></label>
            <label className="text-xs text-muted">{t("settings.mcpPage.credentialTarget")}<input value={delivery === "bearer" ? "Authorization" : targetName} disabled={delivery === "bearer"} onChange={(event) => setTargetName(event.target.value)} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 font-mono text-xs text-text disabled:text-muted" /></label>
            {backend === "managed" ? <label className="text-xs text-muted">{t("settings.mcpPage.credentialSecret")}<input type="password" autoComplete="off" value={secret} placeholder={credential.configured ? t("settings.mcpPage.credentialKeepPlaceholder") : t("settings.mcpPage.credentialEnterPlaceholder")} onChange={(event) => setSecret(event.target.value)} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text" /></label> : <label className="text-xs text-muted">{t("settings.mcpPage.credentialSourceEnv")}<input value={environmentVariable} onChange={(event) => setEnvironmentVariable(event.target.value)} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 font-mono text-xs text-text" /></label>}
            {credentialError && <p role="alert" className="text-xs text-error-text md:col-span-2">{credentialError}</p>}
            <div className="flex justify-end gap-3 md:col-span-2">{credential.credential_ref && <button type="button" disabled={credentialBusy} onClick={() => void removeCredential()} className="px-3 py-2 text-xs text-error-text disabled:text-muted">{t("settings.mcpPage.removeCredential")}</button>}<button type="button" disabled={credentialBusy || !targetName || (backend === "environment" && !environmentVariable) || (backend === "managed" && !secret && !credential.configured)} onClick={() => void saveCredential()} className="inline-flex items-center gap-1 rounded-input bg-accent px-3 py-2 text-xs text-white disabled:opacity-50">{credentialBusy && <Loader2 size={12} className="animate-spin" />}{t("settings.mcpPage.saveCredential")}</button></div>
          </div> : credentialError ? <p role="alert" className="mt-3 rounded-input bg-error/10 px-3 py-2 text-xs text-error-text">{credentialError}</p> : <div className="mt-3 flex items-center text-xs text-muted"><Loader2 size={12} className="mr-1.5 animate-spin" />{t("settings.mcpPage.loading")}</div>}
        </section>

        <section className="mt-4 rounded-input border border-border bg-surface-2/30 p-3">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-text"><Shield size={13} />{t("settings.mcpPage.security")}</h4>
          <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <Info label={t("settings.mcpPage.dataEgress")} value={t(connector.endpoint_url ? "settings.mcpPage.dataEgress.remote" : "settings.mcpPage.dataEgress.local")} />
            <Info label={t("settings.mcpPage.lastProbe")} value={toolsCachedAt ? new Date(toolsCachedAt).toLocaleString() : t("settings.mcpPage.never")} />
            <InfoLink label={t("settings.mcpPage.terms")} href={connector.runtime_config.terms_url} />
            <InfoLink label={t("settings.mcpPage.privacy")} href={connector.runtime_config.privacy_url} />
          </div>
        </section>

        <div className="mt-4 flex items-center justify-between"><div><h4 className="text-xs font-semibold text-text">{t("settings.mcpPage.toolPermissions")}</h4>{workspaceCwd && <p className="mt-1 text-[10px] text-muted">{t("settings.mcpPage.projectOverrideHint")}</p>}</div><button type="button" aria-label={t("settings.mcpPage.refreshTools")} onClick={onRefresh} className="text-muted"><RefreshCw size={14} /></button></div>
        <div className="mt-2 divide-y divide-border">{tools.length ? tools.map((tool) => <div key={tool.name} className="flex items-center justify-between gap-3 py-2"><div className="min-w-0"><p className="text-xs text-text">{tool.title || tool.name}</p><p className="line-clamp-1 text-[10px] text-muted">{tool.description}</p></div><select aria-label={t("settings.mcpPage.permissionFor", { name: tool.name })} value={workspaceCwd ? tool.decision_scope === "project" ? tool.decision : "inherit" : tool.decision} onChange={(event) => onSetDecision(tool, event.target.value as "inherit" | "allow" | "ask" | "deny")} className="shrink-0 rounded-input border border-border bg-surface px-2 py-1 text-xs text-text">{workspaceCwd && <option value="inherit">{t("settings.mcpPage.permissionInherit")}</option>}<option value="allow">{t("settings.mcpPage.permissionAllow")}</option><option value="ask">{t("settings.mcpPage.permissionAsk")}</option><option value="deny">{t("settings.mcpPage.permissionDeny")}</option></select></div>) : <p className="py-3 text-xs text-muted">{t("settings.mcpPage.noToolMetadata")}</p>}</div>
      </div>
    </td>
  </tr>;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function Info({ label, value }: { label: string; value: string }) { return <div><p className="text-[10px] uppercase tracking-wide text-muted">{label}</p><p className="mt-1 text-text">{value}</p></div>; }
function InfoLink({ label, href }: { label: string; href?: string | null }) { const { t } = useTranslation(); return <div><p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>{href ? <a href={href} target="_blank" rel="noreferrer" className="mt-1 block truncate text-link">{href}</a> : <p className="mt-1 text-muted">{t("settings.mcpPage.notProvided")}</p>}</div>; }
