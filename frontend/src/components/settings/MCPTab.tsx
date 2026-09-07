import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Loader2, Plus, Search, Upload } from "lucide-react";
import type { McpConnector, McpConnectorCreate, McpRuntimeConfig, McpToolSummary } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import { queryClient } from "../../lib/client/query-client";
import { mcpConnectorsKey, mcpConnectorsQuery, settingsApi } from "../../lib/settings";
import { McpRow } from "./McpRow";
import { McpConnectorDetails } from "./McpConnectorDetails";

type Transport = McpConnectorCreate["transport"];
type Filter = "all" | "enabled" | "ready" | "needs-auth" | "local" | "remote" | "imported";
type Binding = McpRuntimeConfig["environment"][string];
type ImportEntry = { name: string; transport: string; importable: boolean; conflict: boolean; contains_sensitive_fields: boolean };
type FormState = {
  name: string; display_name: string; description: string; transport: Transport; location: string; args: string;
  lifecycle: McpRuntimeConfig["lifecycle"]; request_timeout_ms: string; idle_timeout_minutes: string; cwd: string;
  include_tools: string; exclude_tools: string; expose_resources: boolean; auth: McpRuntimeConfig["auth"];
  oauth_client_id: string; oauth_scope: string; terms_url: string; privacy_url: string; environment: string; headers: string;
};

const blank: FormState = {
  name: "", display_name: "", description: "", transport: "streamable_http", location: "", args: "",
  lifecycle: "lazy", request_timeout_ms: "15000", idle_timeout_minutes: "", cwd: "", include_tools: "", exclude_tools: "",
  expose_resources: true, auth: "auto", oauth_client_id: "", oauth_scope: "", terms_url: "", privacy_url: "", environment: "", headers: "",
};

export function MCPTab({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tools, setTools] = useState<McpToolSummary[]>([]);
  const [toolsCachedAt, setToolsCachedAt] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(blank);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<McpConnector | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [importEntries, setImportEntries] = useState<ImportEntry[] | null>(null);
  const [importSource, setImportSource] = useState<string | null>(null);
  const [importSelection, setImportSelection] = useState<Set<string>>(new Set());
  const toolRequest = useRef(0);

  const connectorRead = useQuery(mcpConnectorsQuery(t("settings.mcpPage.loadError")));
  const connectors = connectorRead.data?.connectors ?? [];
  const legacyCount = connectorRead.data?.legacy_count ?? 0;
  const migrationConflicts = connectorRead.data?.migration_conflicts ?? [];
  const formDirty = JSON.stringify(form) !== JSON.stringify(editing ? formFor(editing) : blank);
  const filtered = connectors.filter((connector) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || `${connector.display_name} ${connector.name} ${connector.description}`.toLowerCase().includes(query);
    const matchesFilter = filter === "all"
      || (filter === "enabled" && connector.settings.enabled)
      || (filter === "ready" && ["ready", "connected"].includes(connector.runtime_state))
      || (filter === "needs-auth" && connector.auth_state === "needs-auth")
      || (filter === "local" && ["stdio", "socket"].includes(connector.transport))
      || (filter === "remote" && ["streamable_http", "sse"].includes(connector.transport))
      || (filter === "imported" && connector.source === "imported");
    return matchesSearch && matchesFilter;
  });

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (!(adding || editing) || !formDirty) return; event.preventDefault(); };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [adding, editing, formDirty]);

  const mutate = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await action(); await connectorRead.refetch(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  };
  const updateForm = (patch: Partial<FormState>) => { setForm((current) => ({ ...current, ...patch })); setError(null); setFieldError(null); };
  const closeForm = () => { setAdding(false); setEditing(null); setAdvanced(false); setForm(blank); setFieldError(null); };
  const toggle = async (connector: McpConnector, enabled: boolean) => {
    const previous = queryClient.getQueryData(mcpConnectorsKey);
    queryClient.setQueryData<{ connectors: McpConnector[] }>(mcpConnectorsKey, (current) => current ? { ...current, connectors: current.connectors.map((item) => item.connector_id === connector.connector_id ? { ...item, settings: { ...item.settings, enabled } } : item) } : current);
    setBusy(connector.connector_id); setError(null);
    try { await settingsApi.updateMcpSettings(connector.connector_id, { enabled, include_tools: connector.settings.include_tools, exclude_tools: connector.settings.exclude_tools, approval_mode: connector.settings.approval_mode, revision: connector.settings.revision }); await connectorRead.refetch(); }
    catch (cause) { queryClient.setQueryData(mcpConnectorsKey, previous); setError(message(cause)); }
    finally { setBusy(null); }
  };

  const saveConnector = async () => {
    let body: McpConnectorCreate;
    try { body = buildConnector(form, editing, t); }
    catch (cause) { setFieldError(message(cause)); return; }
    setBusy(editing?.connector_id ?? "new"); setError(null); setFieldError(null);
    try {
      let saved: McpConnector;
      if (editing) {
        const { enabled: _enabled, ...definition } = body;
        saved = await settingsApi.updateMcp(editing.connector_id, { ...definition, revision: editing.revision });
      } else saved = await settingsApi.createMcp(body);
      const probe = await settingsApi.probeMcp(saved.connector_id);
      closeForm();
      if (probe.error) setError(t("settings.mcpPage.probeAfterSaveFailed", { error: probe.error }));
      await connectorRead.refetch();
    } catch (cause) { setError(specificMessage(cause)); }
    finally { setBusy(null); }
  };

  const select = useCallback(async (connector: McpConnector) => {
    const request = ++toolRequest.current;
    setSelectedId(connector.connector_id);
    try {
      const result = await settingsApi.mcpTools(connector.connector_id, workspaceCwd);
      if (request === toolRequest.current) { setTools(result.tools); setToolsCachedAt(result.cached_at); }
    } catch { if (request === toolRequest.current) { setTools([]); setToolsCachedAt(null); } }
  }, [workspaceCwd]);
  const toggleDetails = (connector: McpConnector) => {
    if (selectedId === connector.connector_id) { toolRequest.current += 1; setSelectedId(null); setTools([]); setToolsCachedAt(null); return; }
    void select(connector);
  };
  useEffect(() => { toolRequest.current += 1; setSelectedId(null); setTools([]); setToolsCachedAt(null); }, [workspaceCwd]);

  const beginEdit = (connector: McpConnector) => { setEditing(connector); setAdding(false); setForm(formFor(connector)); setAdvanced(true); setError(null); setFieldError(null); };
  const openImport = async () => {
    setBusy("import-preview"); setError(null);
    try {
      const preview = await settingsApi.previewMcpImport(workspaceCwd);
      setImportEntries(preview.entries); setImportSource(preview.source);
      setImportSelection(new Set(preview.entries.filter((item) => item.importable && !item.conflict).map((item) => item.name)));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  };
  const commitImport = async () => {
    if (!importSelection.size) return;
    await mutate("import", async () => {
      const result = await settingsApi.commitMcpImport(workspaceCwd, [...importSelection]);
      if (result.failed.length) throw new Error(t("settings.mcpPage.importFailed", { error: result.failed.map((item) => `${item.name}: ${item.error}`).join("; ") }));
      for (const connector of result.imported) await settingsApi.probeMcp(connector.connector_id);
      setImportEntries(null); setImportSource(null); setImportSelection(new Set());
    });
  };

  if (connectorRead.isLoading) return <div className="flex min-h-[240px] items-center justify-center text-sm text-muted"><Loader2 size={18} className="mr-2 animate-spin" />{t("settings.mcpPage.loading")}</div>;

  return <div className="space-y-card pt-card">
    <div><p className="text-ui-body text-muted">{t("settings.mcpPage.canonicalDescription")}</p><p className="mt-1 text-ui-caption text-muted">{t("settings.mcpPage.stateHint")}</p></div>
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative min-w-52 flex-1"><span className="sr-only">{t("settings.mcpPage.search")}</span><Search size={14} className="absolute left-3 top-2.5 text-muted" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("settings.mcpPage.searchPlaceholder")} className="w-full rounded-input border border-border bg-surface py-2 pl-9 pr-3 text-xs text-text" /></label>
      <select aria-label={t("settings.mcpPage.filter")} value={filter} onChange={(event) => setFilter(event.target.value as Filter)} className="rounded-input border border-border bg-surface px-3 py-2 text-xs text-text">{(["all", "enabled", "ready", "needs-auth", "local", "remote", "imported"] as Filter[]).map((value) => <option key={value} value={value}>{t(`settings.mcpPage.filter.${value}`)}</option>)}</select>
      <button type="button" onClick={() => void openImport()} disabled={busy !== null} className="inline-flex items-center gap-1 rounded-input border border-border px-3 py-2 text-xs"><Upload size={14} />{t("settings.mcpPage.importExisting")}{legacyCount > 0 && ` (${legacyCount})`}</button>
      <button type="button" onClick={() => { if (adding) closeForm(); else { setEditing(null); setAdding(true); setForm(blank); setError(null); } }} className="inline-flex items-center gap-1 rounded-input bg-accent px-3 py-2 text-xs text-white"><Plus size={14} />{t("settings.mcpPage.addConnector")}</button>
    </div>
    {error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-caption text-error-text">{error}</p>}
    {migrationConflicts.length > 0 && <p role="alert" className="rounded-input bg-warn/10 px-3 py-2 text-ui-caption text-warn-text">{t("settings.mcpPage.migrationConflicts", { count: migrationConflicts.length })}</p>}
    {importEntries && <ImportPanel entries={importEntries} source={importSource} selection={importSelection} busy={busy === "import"} onSelection={setImportSelection} onCancel={() => { setImportEntries(null); setImportSource(null); }} onCommit={() => void commitImport()} />}
    {(adding || editing) && <ConnectorForm form={form} advanced={advanced} editing={Boolean(editing)} busy={busy !== null} error={fieldError} onChange={updateForm} onAdvanced={() => setAdvanced((value) => !value)} onCancel={() => { if (!formDirty || window.confirm(t("settings.mcpPage.discardConfirm"))) closeForm(); }} onSave={() => void saveConnector()} />}
    <section className="ui-card-flat overflow-hidden rounded-card"><table className="w-full table-fixed text-left"><thead className="border-b border-border bg-surface-2/50"><tr><th className="w-[30%] px-4 py-2.5 text-xs text-muted">{t("settings.mcpPage.tableName")}</th><th className="hidden w-[30%] px-4 py-2.5 text-xs text-muted md:table-cell">{t("settings.mcpPage.tableDescription")}</th><th className="w-[24%] px-4 py-2.5 text-xs text-muted">{t("settings.mcpPage.tableStatus")}</th><th className="w-[16%] px-4 py-2.5 text-xs text-muted">{t("settings.mcpPage.tableActions")}</th></tr></thead><tbody className="divide-y divide-border">{filtered.length ? filtered.map((connector) => <Fragment key={connector.connector_id}><McpRow connector={connector} selected={selectedId === connector.connector_id} busy={busy === connector.connector_id} actionsEnabled onSelect={() => toggleDetails(connector)} onProbe={() => void mutate(connector.connector_id, async () => { const result = await settingsApi.probeMcp(connector.connector_id); if (result.error) throw new Error(result.error); if (selectedId === connector.connector_id) await select(connector); })} onToggle={(enabled) => void toggle(connector, enabled)} />{selectedId === connector.connector_id && <McpConnectorDetails connector={connector} tools={tools} toolsCachedAt={toolsCachedAt} workspaceCwd={workspaceCwd} onRefresh={() => void select(connector)} onProbe={() => void mutate(connector.connector_id, async () => { const result = await settingsApi.probeMcp(connector.connector_id); if (result.error) throw new Error(result.error); await select(connector); })} onEdit={() => beginEdit(connector)} onCredentialChanged={async () => { await connectorRead.refetch(); }} onDelete={() => { if (window.confirm(t("settings.mcpPage.deleteConfirm", { name: connector.display_name }))) void mutate(connector.connector_id, async () => { await settingsApi.deleteMcp(connector.connector_id); setSelectedId(null); }); }} onSetDecision={(tool, decision) => void mutate(connector.connector_id, async () => { if (workspaceCwd && decision === "inherit") await settingsApi.clearMcpToolDecision(connector.connector_id, tool.name, workspaceCwd); else await settingsApi.setMcpToolDecision(connector.connector_id, tool.name, decision as "allow" | "ask" | "deny", workspaceCwd); await select(connector); })} />}</Fragment>) : <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-muted">{connectors.length ? t("settings.mcpPage.noMatches") : t("settings.mcpPage.empty")}</td></tr>}</tbody></table></section>
  </div>;
}

function ConnectorForm({ form, advanced, editing, busy, error, onChange, onAdvanced, onCancel, onSave }: { form: FormState; advanced: boolean; editing: boolean; busy: boolean; error: string | null; onChange: (patch: Partial<FormState>) => void; onAdvanced: () => void; onCancel: () => void; onSave: () => void }) {
  const { t } = useTranslation();
  const remote = form.transport === "streamable_http" || form.transport === "sse";
  return <div className="ui-card-flat grid gap-3 rounded-card p-4 md:grid-cols-2">
    <h3 className="text-sm font-semibold text-text md:col-span-2">{t(editing ? "settings.mcpPage.editConnector" : "settings.mcpPage.addConnector")}</h3>
    <Field label={t("settings.mcpPage.fieldName")} value={form.display_name} onChange={(display_name) => onChange({ display_name })} /><Field label={t("settings.mcpPage.fieldId")} value={form.name} onChange={(name) => onChange({ name: name.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
    <label className="text-xs text-muted">{t("settings.mcpPage.fieldTransport")}<select value={form.transport} onChange={(event) => onChange({ transport: event.target.value as Transport, location: "", args: "" })} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text"><option value="streamable_http">{t("settings.mcpPage.transport.streamable_http")}</option><option value="sse">{t("settings.mcpPage.transport.sse")}</option><option value="stdio">{t("settings.mcpPage.transport.stdio")}</option><option value="socket">{t("settings.mcpPage.transport.socket")}</option></select></label>
    <Field label={form.transport === "stdio" ? t("settings.mcpPage.fieldCommand") : form.transport === "socket" ? t("settings.mcpPage.fieldSocketPath") : t("settings.mcpPage.fieldEndpointUrl")} value={form.location} mono onChange={(location) => onChange({ location })} />
    {form.transport === "stdio" && <div className="md:col-span-2"><Field label={t("settings.mcpPage.fieldArguments")} value={form.args} mono onChange={(args) => onChange({ args })} /></div>}
    <label className="text-xs text-muted md:col-span-2">{t("settings.mcpPage.fieldDescription")}<textarea value={form.description} onChange={(event) => onChange({ description: event.target.value })} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text" /></label>
    <button type="button" aria-expanded={advanced} onClick={onAdvanced} className="inline-flex items-center gap-1 text-left text-xs text-link md:col-span-2"><ChevronDown size={14} className={advanced ? "rotate-180" : ""} />{t("settings.mcpPage.advanced")}</button>
    {advanced && <>
      <label className="text-xs text-muted">{t("settings.mcpPage.fieldLifecycle")}<select value={form.lifecycle} onChange={(event) => onChange({ lifecycle: event.target.value as FormState["lifecycle"] })} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text">{["lazy", "eager", "keep-alive", "lazy-keep-alive"].map((value) => <option key={value} value={value}>{t(`settings.mcpPage.lifecycle.${value}`)}</option>)}</select></label>
      <Field label={t("settings.mcpPage.fieldTimeout")} value={form.request_timeout_ms} inputMode="numeric" onChange={(request_timeout_ms) => onChange({ request_timeout_ms })} />
      <Field label={t("settings.mcpPage.fieldIdleTimeout")} value={form.idle_timeout_minutes} inputMode="numeric" onChange={(idle_timeout_minutes) => onChange({ idle_timeout_minutes })} />
      {form.transport === "stdio" && <Field label={t("settings.mcpPage.fieldCwd")} value={form.cwd} mono onChange={(cwd) => onChange({ cwd })} />}
      <Field label={t("settings.mcpPage.fieldIncludeTools")} value={form.include_tools} onChange={(include_tools) => onChange({ include_tools })} />
      <Field label={t("settings.mcpPage.fieldExcludeTools")} value={form.exclude_tools} onChange={(exclude_tools) => onChange({ exclude_tools })} />
      {remote && <label className="text-xs text-muted">{t("settings.mcpPage.auth")}<select value={form.auth} onChange={(event) => onChange({ auth: event.target.value as FormState["auth"] })} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text"><option value="auto">Auto</option><option value="none">None</option><option value="oauth">OAuth</option><option value="bearer">Bearer</option></select></label>}
      {remote && form.auth === "oauth" && <><Field label={t("settings.mcpPage.fieldOauthClientId")} value={form.oauth_client_id} onChange={(oauth_client_id) => onChange({ oauth_client_id })} /><Field label={t("settings.mcpPage.fieldOauthScope")} value={form.oauth_scope} onChange={(oauth_scope) => onChange({ oauth_scope })} /></>}
      <Field label={t("settings.mcpPage.fieldEnvironment")} value={form.environment} mono onChange={(environment) => onChange({ environment })} />
      {remote && <Field label={t("settings.mcpPage.fieldHeaders")} value={form.headers} mono onChange={(headers) => onChange({ headers })} />}
      {remote && <><Field label={t("settings.mcpPage.terms")} value={form.terms_url} mono onChange={(terms_url) => onChange({ terms_url })} /><Field label={t("settings.mcpPage.privacy")} value={form.privacy_url} mono onChange={(privacy_url) => onChange({ privacy_url })} /></>}
      <label className="flex items-center gap-2 text-xs text-muted md:col-span-2"><input type="checkbox" checked={form.expose_resources} onChange={(event) => onChange({ expose_resources: event.target.checked })} />{t("settings.mcpPage.fieldExposeResources")}</label>
      <p className="text-[10px] text-muted md:col-span-2">{t("settings.mcpPage.bindingsHint")}</p>
    </>}
    {error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-xs text-error-text md:col-span-2">{error}</p>}
    <div className="flex justify-end gap-2 md:col-span-2"><button type="button" onClick={onCancel} className="px-3 py-2 text-xs text-muted">{t("settings.mcpPage.cancel")}</button><button type="button" disabled={busy || !form.name || !form.display_name || !form.location || (remote && !isHttpUrl(form.location))} onClick={onSave} className="rounded-input bg-accent px-3 py-2 text-xs text-white disabled:opacity-50">{t(editing ? "settings.mcpPage.saveChanges" : "settings.mcpPage.createAndEnable")}</button></div>
  </div>;
}

function ImportPanel({ entries, source, selection, busy, onSelection, onCancel, onCommit }: { entries: ImportEntry[]; source: string | null; selection: Set<string>; busy: boolean; onSelection: (value: Set<string>) => void; onCancel: () => void; onCommit: () => void }) {
  const { t } = useTranslation();
  return <section className="ui-card-flat rounded-card p-4"><h3 className="text-sm font-semibold text-text">{t("settings.mcpPage.importExisting")}</h3>{source && <p className="mt-1 break-all font-mono text-[10px] text-muted">{source}</p>}<div className="mt-3 divide-y divide-border">{entries.length ? entries.map((entry) => { const disabled = !entry.importable || entry.conflict; return <label key={entry.name} className="flex items-center justify-between gap-3 py-2 text-xs"><span><span className="text-text">{entry.name}</span><span className="ml-2 text-muted">{entry.transport}</span>{entry.conflict && <span className="ml-2 text-warn-text">{t("settings.mcpPage.importConflict")}</span>}{entry.contains_sensitive_fields && <span className="ml-2 text-warn-text">{t("settings.mcpPage.importSensitive")}</span>}</span><input type="checkbox" disabled={disabled} checked={selection.has(entry.name)} onChange={(event) => { const next = new Set(selection); if (event.target.checked) next.add(entry.name); else next.delete(entry.name); onSelection(next); }} /></label>; }) : <p className="py-3 text-xs text-muted">{t("settings.mcpPage.importNone")}</p>}</div><div className="mt-3 flex justify-end gap-2"><button type="button" onClick={onCancel} className="px-3 py-2 text-xs text-muted">{t("settings.mcpPage.cancel")}</button><button type="button" disabled={busy || !selection.size} onClick={onCommit} className="rounded-input bg-accent px-3 py-2 text-xs text-white disabled:opacity-50">{t("settings.mcpPage.importSelected", { count: selection.size })}</button></div></section>;
}

function Field({ label, value, onChange, mono = false, inputMode }: { label: string; value: string; onChange: (value: string) => void; mono?: boolean; inputMode?: "numeric" }) { return <label className="text-xs text-muted">{label}<input value={value} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} className={`mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-text ${mono ? "font-mono text-xs" : ""}`} /></label>; }

function buildConnector(form: FormState, editing: McpConnector | null, t: (key: string, options?: Record<string, unknown>) => string): McpConnectorCreate {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(form.name)) throw new Error(t("settings.mcpPage.validationId"));
  const remote = form.transport === "streamable_http" || form.transport === "sse";
  if (remote) validateHttpUrl(form.location, t("settings.mcpPage.validationEndpoint"));
  if (form.terms_url) validateHttpUrl(form.terms_url, t("settings.mcpPage.validationTerms"));
  if (form.privacy_url) validateHttpUrl(form.privacy_url, t("settings.mcpPage.validationPrivacy"));
  const requestTimeout = optionalNumber(form.request_timeout_ms, t("settings.mcpPage.validationTimeout"));
  const idleTimeout = optionalNumber(form.idle_timeout_minutes, t("settings.mcpPage.validationIdleTimeout"));
  const preserve = (bindings: Record<string, Binding> | undefined) => Object.fromEntries(Object.entries(bindings ?? {}).filter(([, binding]) => binding.kind !== "environment"));
  return {
    name: form.name, display_name: form.display_name.trim(), description: form.description.trim(), transport: form.transport,
    endpoint_url: remote ? form.location.trim() : null, command: form.transport === "stdio" ? form.location.trim() : null,
    socket_path: form.transport === "socket" ? form.location.trim() : null, args: form.transport === "stdio" ? splitArguments(form.args, t("settings.mcpPage.validationArguments")) : [],
    credential_ref: editing?.credential_ref ?? null, enabled: editing?.settings.enabled ?? true,
    runtime_config: {
      lifecycle: form.lifecycle, expose_resources: form.expose_resources, include_tools: splitList(form.include_tools), exclude_tools: splitList(form.exclude_tools),
      environment: { ...preserve(editing?.runtime_config.environment), ...parseBindings(form.environment, t("settings.mcpPage.validationEnvironment"), true) },
      headers: { ...preserve(editing?.runtime_config.headers), ...parseBindings(form.headers, t("settings.mcpPage.validationHeaders"), false) },
      auth: remote ? form.auth : "none", allow_private: editing?.runtime_config.allow_private ?? false,
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}), ...(requestTimeout === null ? {} : { request_timeout_ms: requestTimeout }),
      ...(idleTimeout === null ? {} : { idle_timeout_minutes: idleTimeout }), ...(form.oauth_client_id.trim() ? { oauth_client_id: form.oauth_client_id.trim() } : {}),
      ...(form.oauth_scope.trim() ? { oauth_scope: form.oauth_scope.trim() } : {}), ...(form.terms_url.trim() ? { terms_url: form.terms_url.trim() } : {}),
      ...(form.privacy_url.trim() ? { privacy_url: form.privacy_url.trim() } : {}),
    },
  };
}

function formFor(connector: McpConnector): FormState {
  const runtime = connector.runtime_config;
  return {
    name: connector.name, display_name: connector.display_name, description: connector.description, transport: connector.transport,
    location: connector.endpoint_url ?? connector.command ?? connector.socket_path ?? "", args: connector.args.join(" "), lifecycle: runtime.lifecycle,
    request_timeout_ms: runtime.request_timeout_ms?.toString() ?? "", idle_timeout_minutes: runtime.idle_timeout_minutes?.toString() ?? "", cwd: runtime.cwd ?? "",
    include_tools: runtime.include_tools.join(", "), exclude_tools: runtime.exclude_tools.join(", "), expose_resources: runtime.expose_resources, auth: runtime.auth,
    oauth_client_id: runtime.oauth_client_id ?? "", oauth_scope: runtime.oauth_scope ?? "", terms_url: runtime.terms_url ?? "", privacy_url: runtime.privacy_url ?? "",
    environment: bindingLines(runtime.environment), headers: bindingLines(runtime.headers),
  };
}
function bindingLines(bindings: Record<string, Binding>): string { return Object.entries(bindings).filter(([, binding]) => binding.kind === "environment").map(([key, binding]) => `${key}=${binding.kind === "environment" ? binding.name : ""}`).join("\n"); }
function parseBindings(value: string, validationMessage: string, environmentKeys: boolean): Record<string, Binding> { const entries: Record<string, Binding> = {}; for (const raw of value.split(/\n+/).map((line) => line.trim()).filter(Boolean)) { const split = raw.indexOf("="); const key = raw.slice(0, split).trim(); const name = raw.slice(split + 1).trim(); const validKey = environmentKeys ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) : key.length > 0 && key.length <= 200; if (split < 1 || !validKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(validationMessage); entries[key] = { kind: "environment", name }; } return entries; }
function splitList(value: string): string[] { return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))]; }
function splitArguments(value: string, validationMessage: string): string[] {
  const result: string[] = [];
  let current = ""; let quote: "'" | '"' | null = null; let escaped = false; let started = false;
  for (const character of value) {
    if (escaped) { current += character; escaped = false; started = true; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (character === quote) quote = null; else current += character; started = true; continue; }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (/\s/.test(character)) { if (started) { result.push(current); current = ""; started = false; } continue; }
    current += character; started = true;
  }
  if (quote || escaped) throw new Error(validationMessage);
  if (started) result.push(current);
  return result;
}
function optionalNumber(value: string, validationMessage: string): number | null { if (!value.trim()) return null; const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new Error(validationMessage); return number; }
function isHttpUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } }
function validateHttpUrl(value: string, validationMessage: string): void { if (!isHttpUrl(value)) throw new Error(validationMessage); }
function specificMessage(error: unknown): string { if (error && typeof error === "object" && "detail" in error) { const detail = (error as { detail?: { issues?: Array<{ path?: Array<string | number>; message?: string }> } }).detail; const issue = detail?.issues?.[0]; if (issue?.message) return `${issue.path?.join(".") || "request"}: ${issue.message}`; } return message(error); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
