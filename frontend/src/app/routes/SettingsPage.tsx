import { useEffect, useState, useCallback } from "react";
import { Key, Trash2, Eye, EyeOff, Check, Loader2, Cpu, Puzzle, FlaskConical, Server } from "lucide-react";
import { cn } from "../../lib/cn";

type Tab = "llm" | "extensions" | "mcp" | "compute";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "llm", label: "LLM", icon: <Cpu size={14} /> },
  { id: "extensions", label: "Extensions", icon: <Puzzle size={14} /> },
  { id: "mcp", label: "MCP", icon: <FlaskConical size={14} /> },
  { id: "compute", label: "Compute", icon: <Server size={14} /> },
];

interface Provider {
  id: string; name: string; models: string[]; has_key: boolean;
}

interface CustomProvider {
  id: string; name: string; base_url: string; api: string; models: string[]; has_key: boolean;
}

interface Config {
  api_keys: Record<string, boolean>; model: string; thinking: string; providers: Provider[];
  custom_providers: CustomProvider[];
}

interface LLMTabProps {
  config: Config;
  apiKeyInput: Record<string, string>;
  setApiKeyInput: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  showKey: Record<string, boolean>;
  setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  saving: string | null;
  saveKey: (provider: string) => Promise<void>;
  deleteKey: (provider: string) => Promise<void>;
  saveModel: () => Promise<void>;
  onConfigReload: () => Promise<void>;
}

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("llm");
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/config");
      setConfig(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveKey = async (provider: string) => {
    const key = apiKeyInput[provider]?.trim();
    if (!key) return;
    setSaving(provider);
    try {
      await fetch("/api/settings/api-key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, api_key: key }) });
      setApiKeyInput((prev) => ({ ...prev, [provider]: "" }));
      await loadConfig();
    } catch (e) { console.error(e); }
    finally { setSaving(null); }
  };

  const deleteKey = async (provider: string) => {
    setSaving(provider);
    try {
      await fetch(`/api/settings/api-key/${provider}`, { method: "DELETE" });
      await loadConfig();
    } catch (e) { console.error(e); }
    finally { setSaving(null); }
  };

  const saveModel = async (model: string, thinking?: string) => {
    setSaving("model");
    try {
      await fetch("/api/settings/model", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, thinking: thinking || config?.thinking || "high" }) });
      await loadConfig();
    } catch (e) { console.error(e); }
    finally { setSaving(null); }
  };

  if (loading) return <div className="flex items-center justify-center h-full text-sm text-muted"><Loader2 size={18} className="animate-spin mr-2" />Loading…</div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-8 py-8">
        <h1 className="font-serif text-xl text-text mb-6">Settings</h1>

        {/* Tab bar */}
        <div className="flex gap-1 mb-6 rounded-input bg-surface-2 p-0.5 w-fit">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn("flex items-center gap-1.5 rounded-input px-3 py-1.5 text-[13px] font-medium transition-colors",
                tab === t.id ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {tab === "llm" && <LLMTab config={config!} apiKeyInput={apiKeyInput} setApiKeyInput={setApiKeyInput} showKey={showKey} setShowKey={setShowKey} saving={saving} saveKey={saveKey} deleteKey={deleteKey} saveModel={saveModel} onConfigReload={loadConfig} />}
        {tab === "extensions" && <ExtensionsTab />}
        {tab === "mcp" && <MCPTab />}
        {tab === "compute" && <ComputeTab />}
      </div>
    </div>
  );
}

/* ── LLM Tab ── */

function LLMTab({ config, apiKeyInput, setApiKeyInput, showKey, setShowKey, saving, saveKey, deleteKey, saveModel, onConfigReload }: LLMTabProps) {
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  if (!config) return <div className="text-sm text-muted py-4"><Loader2 size={16} className="animate-spin inline mr-2" />Loading…</div>;

  const mainProviders = (config.providers || []).filter((p: Provider) => ["anthropic", "openai", "google", "deepseek", "groq", "openrouter"].includes(p.id));
  const otherProviders = (config.providers || []).filter((p: Provider) => !["anthropic", "openai", "google", "deepseek", "groq", "openrouter"].includes(p.id));

  return (
    <div className="space-y-6">
      {/* Model & Thinking */}
      <Section title="Model">
        <div className="rounded-card border border-border bg-surface px-4 py-3 space-y-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-text flex-1 truncate">{config.model}</span>
            <div className="flex gap-1">
              {["off", "minimal", "low", "medium", "high", "max"].map((level) => (
                <button key={level} onClick={() => saveModel(config.model, level)}
                  className={cn("rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                    config.thinking === level ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-text")}>{level}</button>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* API Keys — main providers in compact grid */}
      <Section title="API Keys">
        <p className="text-[11px] text-muted mb-3">Stored in <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">~/.pi-science/config.json</code>. Click a provider to set its key.</p>
        <div className="grid grid-cols-3 gap-2">
          {mainProviders.map((p: Provider) => (
            <button key={p.id}
              onClick={() => !p.has_key && setExpandedProvider(expandedProvider === p.id ? null : p.id)}
              className={cn(
                "rounded-card border px-3 py-2.5 text-left transition-colors",
                p.has_key ? "border-ok/30 bg-ok/5 cursor-default" : "border-border bg-surface hover:border-accent/30 cursor-pointer",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-text">{p.name}</span>
                {p.has_key
                  ? <span className="shrink-0 text-ok"><Check size={13} /></span>
                  : <span className="shrink-0 text-[10px] text-muted">+ key</span>
                }
              </div>
              {!p.has_key && expandedProvider === p.id && (
                <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <input type={showKey[p.id] ? "text" : "password"}
                    value={apiKeyInput[p.id] || ""}
                    onChange={(e) => setApiKeyInput((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    placeholder="sk-..."
                    className="flex-1 min-w-0 rounded-input border border-border bg-surface-2 px-2 py-1 text-[12px] text-text outline-none font-mono"
                    onKeyDown={(e) => { if (e.key === "Enter") { saveKey(p.id); setExpandedProvider(null); } }}
                    autoFocus />
                  <button onClick={() => setShowKey((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                    className="shrink-0 rounded p-1 text-muted hover:text-text">
                    {showKey[p.id] ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button onClick={() => { saveKey(p.id); setExpandedProvider(null); }}
                    disabled={!apiKeyInput[p.id]?.trim() || saving === p.id}
                    className="shrink-0 rounded bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg disabled:opacity-40">
                    {saving === p.id ? <Loader2 size={11} className="animate-spin" /> : "Save"}
                  </button>
                </div>
              )}
              {p.has_key && (
                <button onClick={(e) => { e.stopPropagation(); deleteKey(p.id); }}
                  disabled={saving === p.id}
                  className="mt-1.5 text-[10px] text-muted hover:text-error transition-colors">
                  Remove key
                </button>
              )}
            </button>
          ))}
        </div>
        {/* Model chips per provider */}
        <div className="mt-3 space-y-1">
          {mainProviders.filter((p: Provider) => p.has_key).map((p: Provider) => (
            <div key={`models-${p.id}`} className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted w-16 shrink-0 truncate">{p.id}</span>
              <div className="flex flex-wrap gap-0.5">
                {p.models.map((m: string) => (
                  <button key={m} onClick={() => saveModel(`${p.id}/${m}`)}
                    className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                      config.model === `${p.id}/${m}` ? "bg-accent/15 text-accent ring-1 ring-accent/30" : "text-muted hover:bg-surface-2 hover:text-text")}>{m}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Other providers — collapsed list */}
      {otherProviders.length > 0 && (
        <Section title="Other Providers">
          <div className="grid grid-cols-3 gap-1.5">
            {otherProviders.map((p: Provider) => (
              <div key={p.id} className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[12px] text-muted">
                {p.has_key && <span className="h-1.5 w-1.5 rounded-full bg-ok shrink-0" />}
                <span className="truncate">{p.name}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <CustomApiSection providers={config.custom_providers || []} onConfigReload={onConfigReload} />
    </div>
  );
}

function CustomApiSection({ providers, onConfigReload }: { providers: CustomProvider[]; onConfigReload: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [discovered, setDiscovered] = useState<CustomProvider | null>(null);
  const [busy, setBusy] = useState<"discover" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discover = async () => {
    if (!baseUrl.trim()) return;
    setBusy("discover");
    setError(null);
    try {
      const res = await fetch("/api/settings/custom-providers/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "Custom API", base_url: baseUrl.trim(), api_key: apiKey, api }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Model discovery failed");
      setDiscovered(data.provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!discovered) return;
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`/api/settings/custom-providers/${encodeURIComponent(discovered.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: discovered.name,
          base_url: discovered.base_url,
          api_key: apiKey,
          api: discovered.api,
          models: discovered.models,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Could not save custom provider");
      setDiscovered(null);
      setName(""); setBaseUrl(""); setApiKey("");
      await onConfigReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    const res = await fetch(`/api/settings/custom-providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.detail || "Could not remove custom provider");
      return;
    }
    await onConfigReload();
  };

  return (
    <Section title="Custom API">
      <div className="rounded-card border border-border bg-surface px-4 py-4 space-y-3">
        <p className="text-[11px] text-muted">
          Fill in an OpenAI-compatible endpoint. Pi-Science calls <code className="font-mono">/models</code> and adds the discovered models to the model selector.
        </p>
        {error && <p className="rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Provider name (optional)" className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none" />
          <select value={api} onChange={(e) => setApi(e.target.value)} className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none">
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
        </div>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className="w-full rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
        <div className="flex gap-2">
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key" className="min-w-0 flex-1 rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
          <button onClick={discover} disabled={!baseUrl.trim() || busy !== null} className="rounded-input bg-accent px-3 py-2 text-[12px] font-medium text-accent-fg disabled:opacity-40">
            {busy === "discover" ? "Discovering…" : "Discover models"}
          </button>
        </div>
        {discovered && (
          <div className="rounded-input border border-accent/30 bg-accent/5 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text">{discovered.name}</span>
              <button onClick={save} disabled={busy !== null} className="rounded-input bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg disabled:opacity-40">
                {busy === "save" ? "Saving…" : "Save provider"}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-muted">{discovered.models.length} models discovered</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {discovered.models.map((model) => <span key={model} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text">{model}</span>)}
            </div>
          </div>
        )}
        {providers.map((provider) => (
          <div key={provider.id} className="flex items-start justify-between gap-3 border-t border-faint pt-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-medium text-text">
                <span className="truncate">{provider.name}</span>
                {provider.has_key && <span className="text-[10px] text-ok">key saved</span>}
              </div>
              <p className="truncate font-mono text-[10px] text-muted">{provider.base_url}</p>
              <p className="mt-1 text-[10px] text-muted">{provider.models.join(", ")}</p>
            </div>
            <button onClick={() => remove(provider.id)} className="shrink-0 rounded-input px-2 py-1 text-[11px] text-error hover:bg-error/10">Remove</button>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ── Extensions Tab ── */

function ExtensionsTab() {
  return (
    <div className="space-y-6">
      <Section title="Installed Extensions">
        <p className="text-[11px] text-muted mb-3">
          Extensions loaded from the pi runtime. Install via <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">npm install</code> in the pi repo.
        </p>
        <ExtCard name="MCP Adapter" pkg="pi-mcp-adapter" desc="Bridges MCP servers into pi. One proxy tool for all servers with lazy loading and OAuth support." checked />
        <ExtCard name="Subagents" pkg="pi-subagents" desc="Delegate work to focused child agents: scout, researcher, planner, worker, reviewer, oracle." checked />
        <ExtCard name="Web Access" pkg="pi-web-access" desc="Web search, URL fetching, YouTube/video understanding. Multi-provider with smart fallbacks." checked />
        <ExtCard name="Context Mode" pkg="context-mode" desc="Sandboxed code execution (12 languages) + FTS5 knowledge index. Reduces context bloat by up to 98% in long scientific sessions." checked />
      </Section>
    </div>
  );
}

function ExtCard({ name, pkg, desc, checked }: { name: string; pkg: string; desc: string; checked: boolean }) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3 mb-2">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <span className="text-sm font-medium text-text">{name}</span>
          <span className="ml-2 font-mono text-[10px] text-muted">{pkg}</span>
          <p className="text-[11px] text-muted mt-0.5">{desc}</p>
        </div>
        {checked && <span className="rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-medium text-ok ring-1 ring-ok/30"><Check size={10} className="inline mr-0.5" />Installed</span>}
      </div>
    </div>
  );
}

/* ── MCP Tab ── */

function MCPTab() {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings/mcp").then(r => r.json()).then(d => {
      const map: Record<string, boolean> = {};
      (d.servers || []).forEach((s: string) => { map[s] = true; });
      setEnabled(map);
    }).finally(() => setLoading(false));
  }, []);

  const toggle = async (id: string, on: boolean) => {
    const previous = !!enabled[id];
    setError(null);
    setEnabled((prev) => ({ ...prev, [id]: on }));
    const res = await fetch(`/api/settings/mcp/${id}?enabled=${on}`, { method: "PUT" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setEnabled((prev) => ({ ...prev, [id]: previous }));
      setError(data.detail || `Could not update MCP server: ${res.statusText}`);
    }
  };

  if (loading) return <div className="text-sm text-muted py-4"><Loader2 size={16} className="animate-spin inline mr-2" />Loading…</div>;

  return (
    <div className="space-y-6">
      <Section title="Science MCP Connectors">
        {error && <p className="mb-3 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error">{error}</p>}
        <p className="text-[11px] text-muted mb-3">
          Open-source scientific MCP servers. Enable to give the agent access to literature databases, material properties, weather data, and more.
          Requires the MCP Adapter extension.
        </p>
        <div className="space-y-2">
          <McpRow id="paper-search" label="Literature Search" disc="all fields" desc="arXiv, PubMed, Crossref, Semantic Scholar, bioRxiv/medRxiv" src="github.com/openags/paper-search-mcp" keyEnv={null} enabled={!!enabled["paper-search"]} onToggle={toggle} />
          <McpRow id="biomcp" label="Biomedical Databases" disc="biology" desc="PubMed, ClinicalTrials.gov, genomic variants" src="github.com/genomoncology/biomcp" keyEnv={null} enabled={!!enabled["biomcp"]} onToggle={toggle} />
          <McpRow id="materials-project" label="Materials Project" disc="materials" desc="Material properties, crystal structures, phase diagrams" src="github.com/luffysolution-svg/mcp-materials-project" keyEnv="MP_API_KEY" enabled={!!enabled["materials-project"]} onToggle={toggle} />
          <McpRow id="fred" label="FRED Economic Data" disc="economics" desc="GDP, inflation, unemployment (Federal Reserve)" src="github.com/tosin2013/fred-mcp" keyEnv="FRED_API_KEY" enabled={!!enabled["fred"]} onToggle={toggle} />
          <McpRow id="open-meteo" label="Weather & Climate" disc="earth/climate" desc="Current & historical weather, air quality (free, no key)" src="github.com/isdaniel/mcp_weather_server" keyEnv={null} enabled={!!enabled["open-meteo"]} onToggle={toggle} />
        </div>
      </Section>
    </div>
  );
}

function McpRow({ id, label, disc, desc, src, keyEnv, enabled, onToggle }: {
  id: string; label: string; disc: string; desc: string; src: string; keyEnv: string | null; enabled: boolean; onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text">{label}</span>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{disc}</span>
          </div>
          <p className="text-[11px] text-muted mt-0.5">{desc}</p>
          <div className="flex items-center gap-2 mt-1.5">
            <a href={`https://${src}`} target="_blank" className="font-mono text-[10px] text-link hover:underline">{src}</a>
            {keyEnv && <span className="text-[10px] text-warn">Needs {keyEnv}</span>}
            {enabled && <span className="text-[10px] text-ok">Enabled</span>}
          </div>
        </div>
        <button
          onClick={() => onToggle(id, !enabled)}
          className={cn(
            "shrink-0 rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
            enabled ? "bg-ok text-white" : "bg-surface-2 text-muted hover:bg-surface hover:text-text",
          )}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}

/* ── Compute Tab ── */

interface Machine {
  label: string; host: string; user: string; port: number;
  identity_file: string; scheduler: string;
}

function ComputeTab() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ host: "", label: "", user: "", port: 22, identity_file: "", scheduler: "" });
  const [adding, setAdding] = useState(false);
  const [probing, setProbing] = useState<Record<string, any>>({});
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/compute/machines");
      const d = await res.json();
      setMachines(d.machines || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!form.host.trim()) return;
    setAdding(true); setError("");
    try {
      await fetch("/api/compute/machines", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      setForm({ host: "", label: "", user: "", port: 22, identity_file: "", scheduler: "" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setAdding(false); }
  };

  const handleDelete = async (label: string) => {
    await fetch(`/api/compute/machines/${label}`, { method: "DELETE" });
    await load();
  };

  const handleProbe = async (machine: Machine) => {
    setProbing((p) => ({ ...p, [machine.label]: true }));
    try {
      const params = new URLSearchParams({ host: machine.host, user: machine.user, port: String(machine.port), identity_file: machine.identity_file });
      const res = await fetch(`/api/compute/probe?${params}`, { method: "POST" });
      const info = await res.json();
      setProbing((p) => ({ ...p, [machine.label]: info }));
    } catch (e) { console.error(e); }
    finally { setProbing((p) => ({ ...p, [machine.label]: false })); }
  };

  if (loading) return <div className="text-sm text-muted py-4">Loading…</div>;

  return (
    <div className="space-y-6">
      <Section title="Remote Machines">
        <p className="text-[11px] text-muted mb-3">
          Configure SSH servers, GPU boxes, or Slurm clusters for remote computation.
          Config is saved to <code className="font-mono text-[11px] bg-surface-2 px-1 rounded">.pi-science/compute.json</code>.
        </p>
        <div className="rounded-card border border-border bg-surface p-4 mb-3">
          <div className="grid grid-cols-3 gap-2 mb-2">
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Label*" className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none" />
            <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="Hostname*" className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none font-mono" />
            <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="User" className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none" />
          </div>
          <div className="flex items-center gap-2">
            <select value={form.scheduler} onChange={(e) => setForm({ ...form, scheduler: e.target.value })} className="rounded-input border border-border bg-surface-2 px-2 py-1.5 text-xs text-text outline-none">
              <option value="">Direct SSH</option>
              <option value="slurm">Slurm</option>
            </select>
            <button onClick={handleAdd} disabled={!form.host.trim() || adding}
              className="rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40">{adding ? "Adding…" : "Add Machine"}</button>
            {error && <span className="text-xs text-error">{error}</span>}
          </div>
        </div>
        {machines.length === 0 ? (
          <p className="text-[12px] text-muted/60 italic">No machines configured</p>
        ) : (
          machines.map((m) => (
            <div key={m.label} className="rounded-card border border-border bg-surface px-4 py-3 mb-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-text">{m.label}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted">{m.user}@{m.host}:{m.port}</span>
                  {m.scheduler && <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-accent">{m.scheduler}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleProbe(m)} disabled={!!probing[m.label]}
                    className="rounded-input px-2 py-1 text-[11px] text-link hover:bg-surface-2">
                    {probing[m.label] === true ? <Loader2 size={12} className="animate-spin" /> : probing[m.label] ? "Probed" : "Probe"}
                  </button>
                  <button onClick={() => handleDelete(m.label)} className="rounded-input px-2 py-1 text-[11px] text-error hover:bg-error/10">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {probing[m.label] && typeof probing[m.label] === "object" && (
                <div className="mt-2 rounded-input bg-surface-2 p-2 font-mono text-[10px] text-muted">
                  {probing[m.label].reachable
                    ? `Cores: ${probing[m.label].cores} · RAM: ${probing[m.label].memory} · GPUs: ${probing[m.label].gpus} · Slurm: ${probing[m.label].has_slurm ? "yes" : "no"}`
                    : `Error: ${probing[m.label].error || "unreachable"}`}
                </div>
              )}
            </div>
          ))
        )}
      </Section>
    </div>
  );
}

/* ── Shared ── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">{title}</h2>
      {children}
    </section>
  );
}
