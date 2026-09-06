import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, Upload } from "lucide-react";
import type { McpConnector, McpConnectorCreate, McpToolSummary } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import { queryClient } from "../../lib/client/query-client";
import { mcpConnectorsKey, mcpConnectorsQuery, settingsApi } from "../../lib/settings";
import { McpRow } from "./McpRow";
import { McpConnectorDetails } from "./McpConnectorDetails";

type Transport = McpConnectorCreate["transport"];
const blank = { name: "", display_name: "", description: "", transport: "streamable_http" as Transport, location: "", args: "" };

export function MCPTab({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tools, setTools] = useState<McpToolSummary[]>([]);
  const [form, setForm] = useState(blank);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toolRequest = useRef(0);

  const connectorRead = useQuery(mcpConnectorsQuery(t("settings.mcpPage.loadError")));
  const connectors = connectorRead.data?.connectors ?? [];
  const legacyCount = connectorRead.data?.legacy_count ?? 0;
  const migrationConflicts = connectorRead.data?.migration_conflicts ?? [];
  const formDirty = JSON.stringify(form) !== JSON.stringify(blank);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (!adding || !formDirty) return; event.preventDefault(); };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [adding, formDirty]);
  const mutate = async (id: string, action: () => Promise<unknown>) => { setBusy(id); setError(null); try { await action(); await connectorRead.refetch(); } catch (cause) { setError(message(cause)); } finally { setBusy(null); } };
  const toggle = async (connector: McpConnector, enabled: boolean) => {
    const key = mcpConnectorsKey;
    const previous = queryClient.getQueryData(key);
    queryClient.setQueryData<{ connectors: McpConnector[] }>(key, (current) => current ? { ...current, connectors: current.connectors.map((item) => item.connector_id === connector.connector_id ? { ...item, settings: { ...item.settings, enabled } } : item) } : current);
    setBusy(connector.connector_id); setError(null);
    try { await settingsApi.updateMcpSettings(connector.connector_id, { enabled, include_tools: connector.settings.include_tools, exclude_tools: connector.settings.exclude_tools, approval_mode: connector.settings.approval_mode, revision: connector.settings.revision }); await connectorRead.refetch(); }
    catch (cause) { queryClient.setQueryData(key, previous); setError(message(cause)); }
    finally { setBusy(null); }
  };

  const create = async () => {
    const remote = form.transport === "streamable_http" || form.transport === "sse";
    const body: McpConnectorCreate = {
      name: form.name, display_name: form.display_name, description: form.description, transport: form.transport,
      endpoint_url: remote ? form.location : null, command: form.transport === "stdio" ? form.location : null,
      socket_path: form.transport === "socket" ? form.location : null, args: form.transport === "stdio" ? form.args.split(/\s+/).filter(Boolean) : [],
      credential_ref: null, enabled: true,
      runtime_config: { lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "auto", allow_private: false },
    };
    await mutate("new", async () => { await settingsApi.createMcp(body); setAdding(false); setForm(blank); });
  };

  const select = useCallback(async (connector: McpConnector) => {
    const request = ++toolRequest.current;
    setSelectedId(connector.connector_id);
    try {
      const next = (await settingsApi.mcpTools(connector.connector_id, workspaceCwd)).tools;
      if (request === toolRequest.current) setTools(next);
    } catch { if (request === toolRequest.current) setTools([]); }
  }, [workspaceCwd]);
  const toggleDetails = (connector: McpConnector) => {
    if (selectedId === connector.connector_id) { toolRequest.current += 1; setSelectedId(null); setTools([]); return; }
    void select(connector);
  };
  useEffect(() => { toolRequest.current += 1; setSelectedId(null); setTools([]); }, [workspaceCwd]);
  const importLegacy = async () => { await mutate("import", async () => { const preview = await settingsApi.previewMcpImport(workspaceCwd); const names = preview.entries.filter((item) => item.importable && !item.conflict).map((item) => item.name); if (!names.length) throw new Error(t("settings.mcpPage.importNone")); const result = await settingsApi.commitMcpImport(workspaceCwd, names); if (result.failed.length) throw new Error(t("settings.mcpPage.importFailed", { error: result.failed.map((item) => `${item.name}: ${item.error}`).join("; ") })); }); };

  if (connectorRead.isLoading) return <div className="flex min-h-[240px] items-center justify-center text-sm text-muted"><Loader2 size={18} className="mr-2 animate-spin" />{t("settings.mcpPage.loading")}</div>;

  return <div className="space-y-card pt-card">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-ui-body text-muted">{t("settings.mcpPage.canonicalDescription")}</p><p className="mt-1 text-ui-caption text-muted">{t("settings.mcpPage.stateHint")}</p></div><div className="flex gap-2">{legacyCount > 0 && <button type="button" onClick={() => void importLegacy()} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-input border border-border px-3 py-2 text-xs"><Upload size={14} />{t("settings.mcpPage.importLegacy", { count: legacyCount })}</button>}<button type="button" onClick={() => setAdding((value) => !value)} className="inline-flex items-center gap-1 rounded-input bg-accent px-3 py-2 text-xs text-white"><Plus size={14} />{t("settings.mcpPage.addConnector")}</button></div></div>
    {error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-caption text-error-text">{error}</p>}
    {migrationConflicts.length > 0 && <p role="alert" className="rounded-input bg-warn/10 px-3 py-2 text-ui-caption text-warn-text">{t("settings.mcpPage.migrationConflicts", { count: migrationConflicts.length })}</p>}
    {adding && <div className="ui-card-flat grid gap-3 rounded-card p-4 md:grid-cols-2">
      <Field label={t("settings.mcpPage.fieldName")} value={form.display_name} onChange={(value) => setForm({ ...form, display_name: value })} /><Field label={t("settings.mcpPage.fieldId")} value={form.name} onChange={(value) => setForm({ ...form, name: value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
      <label className="text-xs text-muted">{t("settings.mcpPage.fieldTransport")}<select value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value as Transport })} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text"><option value="streamable_http">{t("settings.mcpPage.transport.streamable_http")}</option><option value="sse">{t("settings.mcpPage.transport.sse")}</option><option value="stdio">{t("settings.mcpPage.transport.stdio")}</option><option value="socket">{t("settings.mcpPage.transport.socket")}</option></select></label>
      <Field label={form.transport === "stdio" ? t("settings.mcpPage.fieldCommand") : form.transport === "socket" ? t("settings.mcpPage.fieldSocketPath") : t("settings.mcpPage.fieldEndpointUrl")} value={form.location} mono onChange={(value) => setForm({ ...form, location: value })} />
      {form.transport === "stdio" && <div className="md:col-span-2"><Field label={t("settings.mcpPage.fieldArguments")} value={form.args} mono onChange={(value) => setForm({ ...form, args: value })} /></div>}
      <label className="text-xs text-muted md:col-span-2">{t("settings.mcpPage.fieldDescription")}<textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text" /></label>
      <div className="md:col-span-2 flex justify-end gap-2"><button type="button" onClick={() => { if (!formDirty || window.confirm(t("settings.mcpPage.discardConfirm"))) { setAdding(false); setForm(blank); } }} className="px-3 py-2 text-xs text-muted">{t("settings.mcpPage.cancel")}</button><button type="button" disabled={busy !== null || !form.name || !form.display_name || !form.location} onClick={() => void create()} className="rounded-input bg-accent px-3 py-2 text-xs text-white">{t("settings.mcpPage.createAndEnable")}</button></div>
    </div>}
        <section className="ui-card-flat overflow-hidden rounded-card"><table className="w-full table-fixed text-left"><thead className="border-b border-border bg-surface-2/50"><tr><th className="w-[30%] px-4 py-2.5 text-xs text-muted">{t("settings.mcpPage.tableName")}</th><th className="hidden w-[30%] px-4 py-2.5 text-xs text-muted md:table-cell">{t("settings.mcpPage.tableDescription")}</th><th className="w-[24%] px-4 py-2.5 text-xs text-muted">{t("settings.mcpPage.tableStatus")}</th><th className="w-[16%] px-4 py-2.5 text-xs text-muted">{t("settings.mcpPage.tableActions")}</th></tr></thead><tbody className="divide-y divide-border">{connectors.length ? connectors.map((connector) => <Fragment key={connector.connector_id}><McpRow connector={connector} selected={selectedId === connector.connector_id} busy={busy === connector.connector_id} actionsEnabled onSelect={() => toggleDetails(connector)} onProbe={() => void mutate(connector.connector_id, async () => { const result = await settingsApi.probeMcp(connector.connector_id); if (result.error) throw new Error(result.error); })} onToggle={(enabled) => void toggle(connector, enabled)} />{selectedId === connector.connector_id && <McpConnectorDetails connector={connector} tools={tools} workspaceCwd={workspaceCwd} onRefresh={() => void select(connector)} onCredentialChanged={async () => { await connectorRead.refetch(); }} onDelete={() => { if (window.confirm(t("settings.mcpPage.deleteConfirm", { name: connector.display_name }))) void mutate(connector.connector_id, async () => { await settingsApi.deleteMcp(connector.connector_id); setSelectedId(null); }); }} onSetDecision={(tool, decision) => void mutate(connector.connector_id, async () => { if (workspaceCwd && decision === "inherit") await settingsApi.clearMcpToolDecision(connector.connector_id, tool.name, workspaceCwd); else await settingsApi.setMcpToolDecision(connector.connector_id, tool.name, decision as "allow" | "ask" | "deny", workspaceCwd); await select(connector); })} />}</Fragment>) : <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-muted">{t("settings.mcpPage.empty")}</td></tr>}</tbody></table></section>
  </div>;
}

function Field({ label, value, onChange, mono = false }: { label: string; value: string; onChange: (value: string) => void; mono?: boolean }) { return <label className="text-xs text-muted">{label}<input value={value} onChange={(event) => onChange(event.target.value)} className={`mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text ${mono ? "font-mono text-xs" : ""}`} /></label>; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
